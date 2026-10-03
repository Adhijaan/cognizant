// Nav core: plain code, no Gemini (design.md §7). Snaps each fix to the route, tracks the step,
// and reports threshold crossings as events. Wording and "say it once" live in the gate.

import { type LatLng, type Snap, cumulative, haversine, snapToPolyline } from './geo.ts';

export interface RouteStep {
  index: number;
  /** Cleaned Google instruction for the maneuver at the START of this step. */
  instruction: string;
  maneuver: string;
  distanceMeters: number;
  end: LatLng;
  startAlong: number;
  endAlong: number;
}

export interface Destination {
  name: string;
  placeId?: string;
  /** Where the route ends. Hand-marked for demo buildings; otherwise the Places pin. */
  entrance: LatLng;
  handMarked: boolean;
}

export interface Route {
  points: LatLng[];
  cum: number[];
  length: number;
  steps: RouteStep[];
  durationS: number;
  destination: Destination;
}

export interface RawStep {
  instruction: string;
  maneuver: string;
  distanceMeters: number;
  end: LatLng;
}

/** Places each step on the polyline by snapping its end point, keeping the order monotonic. */
export function buildRoute(points: LatLng[], rawSteps: RawStep[], durationS: number, destination: Destination): Route {
  const cum = cumulative(points);
  const length = cum[cum.length - 1] ?? 0;
  const steps: RouteStep[] = [];
  let startAlong = 0;
  rawSteps.forEach((s, index) => {
    const last = index === rawSteps.length - 1;
    const snap = snapToPolyline(s.end, points, cum, { from: startAlong, to: length });
    const endAlong = last ? length : Math.max(startAlong, Math.min(length, snap?.along ?? startAlong + s.distanceMeters));
    steps.push({ index, instruction: s.instruction, maneuver: s.maneuver, distanceMeters: s.distanceMeters, end: s.end, startAlong, endAlong });
    startAlong = endAlong;
  });
  return { points, cum, length, steps, durationS, destination };
}

export interface Fix extends LatLng {
  accuracy: number;
  heading?: number | null;
  course?: number | null;
  speed?: number | null;
  at: number;
}

export type NavEvent =
  | { kind: 'depart' }
  | { kind: 'turn_ahead'; step: number; distance: number }
  /** landmarkOnly: accuracy is too poor to say "now" — speak only if vision has a landmark to point at. */
  | { kind: 'turn_now'; step: number; landmarkOnly: boolean }
  | { kind: 'off_route'; n: number; reroute: boolean }
  | { kind: 'arrived' }
  | { kind: 'gps_poor' };

export const NAV = {
  firstFixAccuracyM: 25,
  turnAheadM: 40,
  turnNowM: 10,
  /** Above this, "turn now" is skipped and a landmark is used instead. */
  turnNowMaxAccuracyM: 20,
  offRouteM: 25,
  offRouteFixes: 3,
  rerouteMinIntervalMs: 20_000,
  arriveRadiusM: 20,
  arriveAccuracyM: 20,
  gpsPoorM: 25,
  gpsPoorFixes: 5,
  /** How far the snapped point may move per fix, behind and ahead. */
  windowBackM: 30,
  windowAheadM: 100,
};

/** A maneuver worth announcing: an actual change of direction, not "continue". */
export function isTurn(step: RouteStep): boolean {
  if (/LEFT|RIGHT|UTURN/.test(step.maneuver)) return true;
  if (step.maneuver && !/UNSPECIFIED/.test(step.maneuver)) return false;
  return /\b(left|right|u-turn)\b/i.test(step.instruction);
}

export function turnSide(step: RouteStep): 'left' | 'right' | null {
  const text = `${step.maneuver} ${step.instruction}`;
  if (/left/i.test(text)) return 'left';
  if (/right/i.test(text)) return 'right';
  return null;
}

export class NavCore {
  route: Route;
  /** Unique per route within a session, so gate keys from an old route can't collide with a new one. */
  generation: number;
  started = false;
  arrived = false;
  along = 0;
  stepIndex = 0;
  distanceToRoute = 0;
  lastSnap: Snap | null = null;
  lastFix: Fix | null = null;

  private firedAhead = new Set<number>();
  private firedNow = new Set<number>();
  private offCount = 0;
  private offRouteActive = false;
  private offRouteEpisodes = 0;
  private lastRerouteAt = -Infinity;
  private poorCount = 0;
  private poorAnnounced = false;

  constructor(route: Route, generation = 0) {
    this.route = route;
    this.generation = generation;
  }

  /** Install a fresh route after rerouting. */
  setRoute(route: Route, generation = this.generation + 1): void {
    this.route = route;
    this.generation = generation;
    this.along = 0;
    this.stepIndex = 0;
    this.lastSnap = null;
    this.firedAhead.clear();
    this.firedNow.clear();
    this.offCount = 0;
    this.offRouteActive = false;
  }

  /** Stable id for a step in gate keys: "3", or "1-3" after the first reroute. */
  stepId(step: number): string {
    return this.generation === 0 ? String(step) : `${this.generation}-${step}`;
  }

  get currentStep(): RouteStep | undefined {
    return this.route.steps[this.stepIndex];
  }

  /** The next announced maneuver: the first real turn after the current step. */
  nextTurn(): RouteStep | undefined {
    return this.route.steps.slice(this.stepIndex + 1).find(isTurn);
  }

  distanceToNextTurn(): number | null {
    const next = this.nextTurn();
    return next ? Math.max(0, next.startAlong - this.along) : null;
  }

  distanceRemaining(): number {
    return Math.max(0, this.route.length - this.along);
  }

  distanceToEntrance(): number | null {
    return this.lastFix ? haversine(this.lastFix, this.route.destination.entrance) : null;
  }

  /**
   * Feed one GPS fix. `sawDestination` is true when vision recently read the destination's name
   * or saw its door — it stands in for good accuracy at arrival.
   */
  update(fix: Fix, now: number, ctx: { sawDestination?: boolean } = {}): NavEvent[] {
    const events: NavEvent[] = [];
    if (this.arrived) return events;
    this.lastFix = fix;

    // GPS quality: say "GPS is poor" once per stretch.
    if (fix.accuracy > NAV.gpsPoorM) {
      this.poorCount++;
      if (this.started && this.poorCount >= NAV.gpsPoorFixes && !this.poorAnnounced) {
        this.poorAnnounced = true;
        events.push({ kind: 'gps_poor' });
      }
    } else {
      this.poorCount = 0;
      this.poorAnnounced = false;
    }

    // No instruction until the first decent fix.
    if (!this.started) {
      if (fix.accuracy >= NAV.firstFixAccuracyM) return events;
      this.started = true;
      events.push({ kind: 'depart' });
    }

    const { points, cum, steps } = this.route;
    const window = this.lastSnap ? { from: this.along - NAV.windowBackM, to: this.along + NAV.windowAheadM } : undefined;
    let snap = snapToPolyline(fix, points, cum, window);
    // Far from the windowed stretch: the user may have cut a corner. Look at the whole line.
    if (window && (!snap || snap.dist > NAV.offRouteM)) {
      const global = snapToPolyline(fix, points, cum);
      if (global && (!snap || global.dist < snap.dist - 10)) snap = global;
    }
    if (!snap) return events;
    this.lastSnap = snap;
    this.along = snap.along;
    this.distanceToRoute = snap.dist;

    // Arrival: near the entrance AND (good accuracy OR vision confirms the building).
    const toEntrance = haversine(fix, this.route.destination.entrance);
    if (toEntrance <= NAV.arriveRadiusM && (fix.accuracy <= NAV.arriveAccuracyM || ctx.sawDestination)) {
      this.arrived = true;
      events.push({ kind: 'arrived' });
      return events;
    }

    // Off route: several consecutive fixes farther from the line than the accuracy radius explains.
    if (snap.dist > Math.max(NAV.offRouteM, fix.accuracy)) {
      this.offCount++;
      if (this.offCount >= NAV.offRouteFixes) {
        const canReroute = now - this.lastRerouteAt >= NAV.rerouteMinIntervalMs;
        if (!this.offRouteActive || canReroute) {
          if (!this.offRouteActive) this.offRouteEpisodes++;
          this.offRouteActive = true;
          if (canReroute) {
            this.lastRerouteAt = now;
            events.push({ kind: 'off_route', n: this.offRouteEpisodes, reroute: true });
          }
        }
      }
      return events;
    }
    this.offCount = 0;
    this.offRouteActive = false;

    while (this.stepIndex < steps.length - 1 && this.along >= steps[this.stepIndex].endAlong) this.stepIndex++;
    while (this.stepIndex > 0 && this.along < steps[this.stepIndex].startAlong - 5) this.stepIndex--;

    // Thresholds fire once per step, on crossing. The fired sets are the hysteresis:
    // GPS jitter back across the line can't re-arm them.
    const next = this.nextTurn();
    if (next) {
      const distance = Math.max(0, next.startAlong - this.along);
      if (distance <= NAV.turnNowM) {
        if (!this.firedNow.has(next.index)) {
          this.firedNow.add(next.index);
          this.firedAhead.add(next.index);
          events.push({ kind: 'turn_now', step: next.index, landmarkOnly: fix.accuracy > NAV.turnNowMaxAccuracyM });
        }
      } else if (distance <= NAV.turnAheadM && !this.firedAhead.has(next.index)) {
        this.firedAhead.add(next.index);
        events.push({ kind: 'turn_ahead', step: next.index, distance });
      }
    }
    return events;
  }
}
