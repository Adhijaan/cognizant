// Session: the one brain (design.md §3). Frames and fixes come in from the phone, vision and the
// nav core turn them into events, the gate decides what is worth saying, and the phone is told to
// play an earcon or trigger a line. Nav state lives here, keyed by session, so it survives reconnects.

import { WebSocket } from 'ws';
import { config } from './config.ts';
import { chooseAction, fastPath, safeReply, type Action, type Turn, type TurnContext } from './conversation.ts';
import { resolveDestination } from './destination.ts';
import { Gate, type Emission, type GateDecision } from './gate.ts';
import { geminiConfigured } from './gemini.ts';
import { computeWalkingRoute } from './google.ts';
import { earconFor, lowerFirst, obstacleDetail, obstacleLine, spokenDistance, spokenMinutes, upperFirst, clockPosition } from './lines.ts';
import { allLinks, count, log, setLink } from './log.ts';
import { NavCore, turnSide, type Fix, type NavEvent, type Route } from './nav/core.ts';
import { angleDiff, bearingAlong } from './nav/geo.ts';
import { NAV_TAG_RE, type FixMsg, type FrameMsg, type LinkId, type Mode, type ServerToPhone, type StatusMsg, type VoiceMsg } from './protocol.ts';
import { Recorder } from './recorder.ts';
import { checkObstacles, describeScene, findBoxes, findLine, guidanceLine, nearest, readText, type Landmark, type Located, type Observation } from './vision.ts';

interface Frame {
  jpeg: string;
  seq: number;
  capturedAt: number;
  receivedAt: number;
}

interface Scan {
  id: number;
  object: string;
  phase: 'search' | 'guide';
  until: number;
  lastCallAt: number;
  lastSaidAt: number;
  inFlight: boolean;
  prev: Located | null;
  lost: number;
  said: number;
}

const HAZARD_COOLDOWN_MS = 20_000;
const RESULT_MAX_AGE_MS = 3000;
const UNUSABLE_BEFORE_COVERED = 5;
const SCAN_SEARCH_MS = 15_000;
const SCAN_GUIDE_MS = 30_000;
const REASSURE_AFTER_MS = 60_000;
const NO_FRAME_LINE = "I'm not getting pictures from the camera right now.";

const LINK_NAMES: Record<LinkId, string> = {
  L1: 'the app server',
  L2: 'phone data',
  L3: 'the voice connection',
  L4: 'the speech engine',
  L5: 'vision',
  L6: 'routes',
  L7: 'place search',
  L8: 'the voice service',
  L9: 'phone sensors',
  L10: 'the tunnel',
  L11: 'replay',
};

const GENERIC_NAME_WORDS = new Set(['the', 'hall', 'library', 'building', 'center', 'michigan', 'university', 'graduate', 'undergraduate', 'of', 'and']);

export class Session {
  readonly id: string;
  readonly replay: boolean;
  /** Log tag: L2 for a live phone, L11 for a replay. */
  readonly tag: 'L2' | 'L11';
  readonly createdAt = Date.now();
  phone: WebSocket | null = null;
  lastSeenAt = Date.now();

  mode: Mode = 'helping';
  nav: NavCore | null = null;
  destinationName: string | null = null;
  private routeCounter = 0;
  private rerouting = false;

  lastFix: (Fix & { receivedAt: number }) | null = null;
  latestFrame: Frame | null = null;
  observations: { at: number; observation: Observation }[] = [];
  phoneStatus: StatusMsg | null = null;
  voice = { agentSpeaking: false, userSpeaking: false, connected: false, at: 0 };
  conversationId: string | null = null;

  readonly gate: Gate;
  decisions: GateDecision[] = [];
  /** Proactive lines by key: the phone sends [nav:key], the server answers with the stored text. */
  readonly lines = new Map<string, string>();
  turns: Turn[] = [];
  lastSpoken = '';
  private lastSpokenAt = Date.now();
  muted = false;
  private replyInFlight = 0;

  frames = 0;
  fixes = 0;
  geminiCalls = 0;
  private pendingFrame: Frame | null = null;
  private obstacleInFlight = false;
  private visionBackoffUntil = 0;
  private unusableCount = 0;
  private frameWaiters: ((f: Frame | null) => void)[] = [];
  private scan: Scan | null = null;
  private scanCounter = 0;
  private sawDestinationAt = -Infinity;
  private twisted = false;
  private reassureCount = 0;
  private lastReassureAt = Date.now();
  private gpsPoorCount = 0;
  private loggedHeading = false;
  recorder: Recorder | null = null;

  constructor(id: string, opts: { replay?: boolean; record?: boolean } = {}) {
    this.id = id;
    this.replay = Boolean(opts.replay);
    this.tag = this.replay ? 'L11' : 'L2';
    this.gate = new Gate({
      onDecision: (d) => {
        this.decisions.push(d);
        if (this.decisions.length > 100) this.decisions.shift();
        log('gate', 'decision', { key: d.key, action: d.action, reason: d.reason, p: d.priority, session: this.id });
      },
    });
    if (opts.record && !this.replay) {
      this.recorder = new Recorder(config.replayDir, id);
      log(this.tag, 'recording', { dir: this.recorder.dir });
    }
  }

  // ---------------------------------------------------------------- phone I/O

  send(msg: ServerToPhone): void {
    if (this.phone?.readyState === WebSocket.OPEN) this.phone.send(JSON.stringify(msg));
  }

  sendSession(): void {
    const links = Object.fromEntries(Object.entries(allLinks()).map(([id, s]) => [id, s.state]));
    this.send({ type: 'session', session: this.id, mode: this.mode, destination: this.destinationName, links });
  }

  attachPhone(ws: WebSocket): void {
    if (this.phone && this.phone !== ws) this.phone.close(4000, 'replaced by a newer connection');
    this.phone = ws;
    this.lastSeenAt = Date.now();
    // A reconnect mid-scan: the phone has forgotten the cadence.
    if (this.scan) this.send({ type: 'cadence', mode: 'scan' });
  }

  detachPhone(ws: WebSocket): void {
    if (this.phone !== ws) return;
    this.phone = null;
    this.voice = { agentSpeaking: false, userSpeaking: false, connected: false, at: Date.now() };
    for (const waiter of this.frameWaiters.splice(0)) waiter(null);
  }

  handleStatus(msg: StatusMsg): void {
    this.phoneStatus = msg;
    this.recorder?.status(msg);
    // The phone drops dark/blurred bursts before upload, so a covered lens shows up here, not as unusable frames.
    if ((msg.skippedBursts ?? 0) >= UNUSABLE_BEFORE_COVERED) {
      this.gate.offer({ key: 'camera_covered', priority: 8, text: 'The camera looks covered.', ttlMs: 10_000, cooldownMs: 120_000 }, { muted: this.muted });
    }
    if (this.replay) return;
    const missing = [!msg.camera && 'camera', !msg.mic && 'mic', !msg.wakeLock && 'wake lock'].filter(Boolean);
    setLink('L9', msg.camera && msg.mic ? 'ok' : 'down', missing.length ? `missing: ${missing.join(', ')}` : '');
  }

  handleVoice(msg: VoiceMsg): void {
    this.voice = { agentSpeaking: msg.agentSpeaking, userSpeaking: msg.userSpeaking, connected: msg.connected, at: Date.now() };
    if (!this.replay) setLink('L3', msg.connected ? 'ok' : 'down', msg.connected ? '' : 'phone reports the ElevenLabs session is not connected');
  }

  // ---------------------------------------------------------------- frames → vision → gate

  handleFrame(msg: FrameMsg): void {
    const now = Date.now();
    this.lastSeenAt = now;
    count('frames');
    if (this.frames++ === 0) log(this.tag, 'first_frame', { size: `${msg.width ?? '?'}x${msg.height ?? '?'}`, kb: Math.round((msg.jpeg.length * 0.75) / 1024), session: this.id });
    this.recorder?.frame(msg);
    const frame: Frame = { jpeg: msg.jpeg, seq: msg.seq, capturedAt: msg.capturedAt, receivedAt: now };
    this.latestFrame = frame; // memory only; replaced by the next frame
    for (const waiter of this.frameWaiters.splice(0)) waiter(frame);
    void this.onScanFrame(frame);
    this.pendingFrame = frame; // a newer frame replaces a queued one
    void this.pumpObstacles();
  }

  private async pumpObstacles(): Promise<void> {
    if (this.obstacleInFlight) return;
    this.obstacleInFlight = true;
    try {
      while (this.pendingFrame) {
        const frame = this.pendingFrame;
        this.pendingFrame = null;
        if (!geminiConfigured()) return setLink('L5', 'off', 'GEMINI_API_KEY not set');
        if (Date.now() < this.visionBackoffUntil) return;
        if (this.geminiCalls >= config.sessionGeminiCap) {
          this.gate.offer({ key: 'vision_budget', priority: 8, text: "I've reached this session's vision budget, so I can't watch the path any more.", ttlMs: 30_000 });
          return;
        }
        this.geminiCalls++;
        try {
          const { observation } = await checkObstacles(frame.jpeg);
          const age = Date.now() - frame.receivedAt;
          if (age > RESULT_MAX_AGE_MS) {
            log(this.tag, 'observation_drop', { reason: 'stale', age_ms: age, seq: frame.seq });
            continue;
          }
          this.ingestObservation(observation);
        } catch {
          // Logged with status and body in gemini.ts. Back off so a bad key or model isn't hit on every frame.
          this.visionBackoffUntil = Date.now() + 5000;
        }
      }
    } finally {
      this.obstacleInFlight = false;
    }
  }

  ingestObservation(observation: Observation): void {
    const now = Date.now();
    if (!observation.usable) {
      // Dark, blurred or covered: skip it. After several in a row, say so (at most every 2 min).
      if (++this.unusableCount >= UNUSABLE_BEFORE_COVERED) {
        this.gate.offer({ key: 'camera_covered', priority: 8, text: 'The camera looks covered.', ttlMs: 10_000, cooldownMs: 120_000 }, { muted: this.muted });
      }
      return;
    }
    this.unusableCount = 0;
    this.observations.push({ at: now, observation }); // JSON only — never the image
    if (this.observations.length > 5) this.observations.shift();

    // Compass and course disagreeing while walking means the phone has twisted on the lanyard:
    // what the camera calls "ahead" isn't. Hazards still alert; landmarks are not trusted.
    const fix = this.lastFix;
    const twisted = Boolean(fix && (fix.speed ?? 0) > 0.7 && fix.course != null && fix.heading != null && Math.abs(angleDiff(fix.course, fix.heading)) > 60);
    if (twisted !== this.twisted) log(this.tag, 'twisted', { twisted });
    this.twisted = twisted;

    // A frame full of standing people is a crowd, not a list of obstacles: don't narrate people.
    const stopped = observation.obstacles.filter((o) => o.type === 'person_stopped').length;
    for (const o of observation.obstacles) {
      if (!o.in_path || o.distance === 'far') continue;
      if (o.type === 'person_stopped' && stopped >= 3) continue;
      const key = `hazard:${o.type}:${o.position}`;
      if (o.distance === 'near') {
        this.gate.offer({ key, priority: 1, text: obstacleLine(o.type, o.position), earcon: earconFor(o.type, o.position), ttlMs: 3000, cooldownMs: HAZARD_COOLDOWN_MS });
        const detail = obstacleDetail(o.type);
        if (detail) this.gate.offer({ key: `hazard_detail:${o.type}:${o.position}`, priority: 6, text: detail, ttlMs: 5000, cooldownMs: HAZARD_COOLDOWN_MS }, { muted: this.muted });
      } else {
        this.gate.offer({ key, priority: 6, text: obstacleLine(o.type, o.position), ttlMs: 5000, cooldownMs: HAZARD_COOLDOWN_MS }, { muted: this.muted });
      }
    }

    if (this.nav && !twisted) {
      if (this.matchesDestination(observation)) this.sawDestinationAt = now;
      for (const l of observation.landmarks) {
        if (!l.name || !l.evidence) continue; // a name with no legible text behind it is a guess
        this.gate.offer({ key: `landmark:${l.name.toLowerCase()}`, priority: 7, text: `${l.name}${l.position === 'center' ? ' ahead' : ` on your ${l.position}`}`, ttlMs: 10_000 }, { muted: this.muted });
      }
    }
    this.pump();
  }

  private matchesDestination(observation: Observation): boolean {
    if (!this.destinationName) return false;
    const words = this.destinationName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC_NAME_WORDS.has(w));
    if (words.length === 0) return false;
    const seen = [...observation.landmarks.map((l) => `${l.name} ${l.evidence}`), ...observation.visible_text].join(' ').toLowerCase();
    return words.some((w) => seen.includes(w));
  }

  private recentLandmark(side?: 'left' | 'right' | null, maxAgeMs = 10_000): Landmark | null {
    if (this.twisted) return null;
    const now = Date.now();
    for (const { at, observation } of [...this.observations].reverse()) {
      if (now - at > maxAgeMs) break;
      const hit = observation.landmarks.find((l) => l.name && l.evidence && (!side || l.position === side || l.position === 'center'));
      if (hit) return hit;
    }
    return null;
  }

  // ---------------------------------------------------------------- fixes → nav core → gate

  handleFix(msg: FixMsg): void {
    const now = Date.now();
    this.lastSeenAt = now;
    this.recorder?.fix(msg);
    if (!Number.isFinite(msg.lat) || !Number.isFinite(msg.lng)) return;
    if (this.fixes++ === 0) log(this.tag, 'first_fix', { accuracy_m: Math.round(msg.accuracy), session: this.id });
    if (!this.loggedHeading && msg.heading != null) {
      this.loggedHeading = true;
      log(this.tag, 'heading', { deg: Math.round(msg.heading) });
    }
    this.lastFix = { lat: msg.lat, lng: msg.lng, accuracy: msg.accuracy, heading: msg.heading, course: msg.course, speed: msg.speed, at: msg.at, receivedAt: now };
    if (!this.nav || this.nav.arrived) return;
    const events = this.nav.update(this.lastFix, now, { sawDestination: now - this.sawDestinationAt < 15_000 });
    for (const ev of events) this.onNavEvent(ev);
    this.pump();
  }

  /** Standing still → compass. Walking → GPS course (the compass on a swinging phone is the less reliable one). */
  private bestHeading(): number | null {
    const fix = this.lastFix;
    if (!fix) return null;
    if ((fix.speed ?? 0) > 0.7 && fix.course != null && fix.course >= 0) return fix.course;
    return fix.heading ?? null;
  }

  private onNavEvent(ev: NavEvent): void {
    const nav = this.nav!;
    const muted = { muted: this.muted };
    log('nav', ev.kind, { ...ev, kind: undefined, along_m: Math.round(nav.along), off_m: Math.round(nav.distanceToRoute), accuracy_m: Math.round(nav.lastFix?.accuracy ?? -1) });
    switch (ev.kind) {
      case 'depart': {
        // "Head northwest" means little without sight: say which way relative to the body when the heading is known.
        const routeBearing = bearingAlong(nav.route.points, nav.route.cum, nav.along, 20);
        const heading = this.bestHeading();
        let text = nav.route.steps[0]?.instruction || 'Start walking';
        if (routeBearing != null && heading != null) {
          const where = clockPosition(angleDiff(heading, routeBearing));
          text = where === 'straight ahead' ? 'Start walking straight ahead' : where === 'behind you' ? 'The route starts behind you. Turn around' : `Start walking ${where.replace(/^at /, 'toward ')}`;
        }
        this.gate.offer({ key: `depart:${nav.generation}`, priority: 4, text, ttlMs: 20_000, mergeable: true });
        break;
      }
      case 'turn_ahead': {
        const step = nav.route.steps[ev.step];
        // Worded when it is finally spoken: a line that waited for a pause gives the distance as it is then.
        const text = () => {
          let line = `In ${spokenDistance(Math.max(0, step.startAlong - nav.along))}, ${lowerFirst(step.instruction)}`;
          // Unnamed campus paths ("turn right") get a landmark from vision when there is one on that side.
          if (!/\b(onto|on|toward|towards|at)\b/i.test(step.instruction)) {
            const landmark = this.recentLandmark(turnSide(step));
            if (landmark) line += ` toward ${landmark.name}`;
          }
          return line;
        };
        this.gate.offer({
          key: `turn_ahead:${nav.stepId(ev.step)}`,
          priority: 4,
          text,
          ttlMs: null,
          mergeable: true,
          stale: () => this.nav !== nav || nav.along >= step.startAlong - 10, // inside turn-now range
        });
        break;
      }
      case 'turn_now': {
        const step = nav.route.steps[ev.step];
        const side = turnSide(step);
        const key = `turn_now:${nav.stepId(ev.step)}`;
        let text: string;
        if (ev.landmarkOnly) {
          // GPS is too loose to say "now": point at a landmark, or stay silent.
          const landmark = this.recentLandmark(side);
          if (!landmark || !side) {
            log('gate', 'decision', { key, action: 'drop', reason: 'poor_accuracy_no_landmark', p: 2, session: this.id });
            break;
          }
          text = `Turn ${side} toward ${landmark.name}`;
        } else if (/UTURN/.test(step.maneuver)) text = 'Turn around now';
        else if (side) text = `${/SLIGHT/.test(step.maneuver) ? 'Bear' : 'Turn'} ${side} now`;
        else text = step.instruction;
        this.gate.offer({ key, priority: 2, text, ttlMs: null, mergeable: true, stale: () => this.nav !== nav || nav.along > step.startAlong + 15 }); // step passed
        break;
      }
      case 'off_route':
        this.gate.offer({ key: `off_route:${nav.generation}.${ev.n}`, priority: 3, text: 'Rerouting', ttlMs: 10_000 });
        if (ev.reroute) void this.reroute();
        break;
      case 'gps_poor':
        this.gate.offer({ key: `gps_poor:${++this.gpsPoorCount}`, priority: 8, text: "GPS is weak here. I'll lean on landmarks.", ttlMs: 10_000 }, muted);
        break;
      case 'arrived': {
        const dest = nav.route.destination;
        const text = dest.handMarked
          ? `You're at the ${dest.name.replace(/^the /i, '')} entrance. I can help you find things inside`
          : `You've reached ${dest.name}. The entrance should be close. I can help you find the door`;
        this.gate.offer({ key: `arrived:${dest.name.toLowerCase()}:${nav.generation}`, priority: 5, text, ttlMs: null, mergeable: true });
        this.endNavigation('arrived'); // navigation ends; helping continues
        break;
      }
    }
  }

  private async reroute(): Promise<void> {
    const nav = this.nav;
    if (!nav || !this.lastFix || this.rerouting) return;
    this.rerouting = true;
    try {
      const route = await computeWalkingRoute(this.lastFix, nav.route.destination);
      if (this.nav === nav) nav.setRoute(route, ++this.routeCounter);
    } catch {
      // Logged in google.ts. The old route stays; the nav core will ask again after its 20 s limit.
    } finally {
      this.rerouting = false;
    }
  }

  private beginNavigation(route: Route): void {
    this.gate.clear('new_route', isNavKey);
    this.nav = new NavCore(route, ++this.routeCounter);
    this.mode = 'navigating';
    this.destinationName = route.destination.name;
    this.sawDestinationAt = -Infinity;
    this.lastReassureAt = Date.now();
    this.sendSession();
    // Don't wait for the next fix if we already have a good one.
    if (this.lastFix) for (const ev of this.nav.update(this.lastFix, Date.now())) this.onNavEvent(ev);
  }

  private endNavigation(reason: 'arrived' | 'cancelled'): void {
    log('nav', 'end', { reason, destination: this.destinationName, session: this.id });
    if (reason === 'cancelled') this.gate.clear('navigation_cancelled', isNavKey);
    this.nav = null;
    this.mode = 'helping';
    this.destinationName = reason === 'arrived' ? this.destinationName : null;
    this.sendSession();
  }

  // ---------------------------------------------------------------- gate → phone

  /** User and agent both quiet, and no answer on its way. */
  private isQuiet(): boolean {
    return !this.voice.agentSpeaking && !this.voice.userSpeaking && this.replyInFlight === 0;
  }

  /** Runs the gate and delivers whatever it lets through. Called on every event and on a timer. */
  pump(): void {
    const now = Date.now();
    const nav = this.nav;
    if (nav?.started && !nav.arrived && now - this.lastSpokenAt > REASSURE_AFTER_MS && now - this.lastReassureAt > REASSURE_AFTER_MS) {
      this.lastReassureAt = now;
      const toTurn = nav.distanceToNextTurn();
      const text = toTurn != null ? `Still on track. ${upperFirst(spokenDistance(toTurn))} to the next turn` : `Still on track. ${upperFirst(spokenDistance(nav.distanceRemaining()))} to go`;
      this.gate.offer({ key: `reassure:${++this.reassureCount}`, priority: 8, text, ttlMs: 10_000 }, { muted: this.muted });
    }
    if (this.scan && now > this.scan.until && !this.scan.inFlight) this.finishScan();
    for (const emission of this.gate.tick({ quiet: this.isQuiet(), muted: this.muted })) this.deliver(emission);
  }

  private deliver(e: Emission): void {
    this.lastSpoken = e.text;
    this.lastSpokenAt = Date.now();
    this.turns.push({ role: 'agent', content: e.text });
    if (e.kind === 'earcon' && e.clip) {
      // Urgent: the phone plays the bundled clip at once, no conversation round trip.
      this.send({ type: 'earcon', clip: e.clip });
      log(this.tag, 'earcon', { clip: e.clip, key: e.key });
    } else {
      this.speak(e.key, e.text);
    }
  }

  /** Server → phone `speak {key}` → phone sendUserMessage("[nav:key]") → L4 → this.lines.get(key). */
  private speak(key: string, text: string): void {
    this.lines.set(key, text);
    if (this.lines.size > 200) this.lines.delete(this.lines.keys().next().value!);
    this.send({ type: 'speak', key, text });
    log(this.tag, 'speak', { key, text });
  }

  /** A line that answers the user's own question (find results): skips the gate. */
  private sayDirect(key: string, text: string): void {
    this.lastSpoken = text;
    this.lastSpokenAt = Date.now();
    this.turns.push({ role: 'agent', content: text });
    this.gate.noteSpeech();
    this.speak(key, text);
  }

  // ---------------------------------------------------------------- user turns (L4, or `say` in replay)

  /** Returns the exact text to speak. A [nav:key] turn is answered from the stored lines, with no Gemini call. */
  async handleUserTurn(text: string, signal?: AbortSignal): Promise<string> {
    const tag = NAV_TAG_RE.exec(text);
    if (tag) {
      const line = this.lines.get(tag[1]) ?? '';
      if (!line) log('L4', 'proactive_miss', { key: tag[1], session: this.id });
      return line;
    }
    this.lastSeenAt = Date.now();
    this.recorder?.say(text);
    this.turns.push({ role: 'user', content: text });
    if (this.turns.length > 40) this.turns.splice(0, this.turns.length - 40);
    this.replyInFlight++;
    const started = Date.now();
    let action: Action | null = null;
    try {
      action = fastPath(text) ?? (await chooseAction(this.turns, this.turnContext(), signal));
      const reply = safeReply(await this.run(action, signal));
      signal?.throwIfAborted();
      log('L4', 'reply', { action: action.action, arg: action.argument, ms: Date.now() - started, text: reply });
      if (action.action !== 'repeat_last') this.lastSpoken = reply;
      this.lastSpokenAt = Date.now();
      this.turns.push({ role: 'agent', content: reply });
      this.gate.noteSpeech();
      return reply;
    } catch (err) {
      if (signal?.aborted) throw err; // the user interrupted: drop the in-flight response
      log('L4', 'reply', { ok: false, action: action?.action, ms: Date.now() - started, body: String(err).slice(0, 200) });
      return geminiConfigured() ? "Sorry, I couldn't work that out. Please say it again." : "My vision service isn't set up yet, so I can only take simple commands.";
    } finally {
      this.replyInFlight--;
    }
  }

  private turnContext(): TurnContext {
    const now = Date.now();
    const nav = this.nav;
    return {
      mode: this.mode,
      destination: this.destinationName,
      current_step: nav?.currentStep?.instruction ?? null,
      distance_to_next_turn_m: nav ? round(nav.distanceToNextTurn()) : null,
      distance_remaining_m: nav ? round(nav.distanceRemaining()) : null,
      gps_accuracy_m: this.lastFix ? Math.round(this.lastFix.accuracy) : null,
      observations: this.observations.slice(-3).map(({ at, observation: o }) => ({
        age_s: Math.round((now - at) / 1000),
        obstacles: o.obstacles.map((x) => `${x.type} ${x.position} ${x.distance}`),
        landmarks: o.landmarks.map((l) => l.name),
        visible_text: o.visible_text,
      })),
      last_spoken: this.lastSpoken,
      quiet_mode: this.muted,
    };
  }

  private async run(action: Action, signal?: AbortSignal): Promise<string> {
    switch (action.action) {
      case 'reply':
        return action.reply || "I'm not sure. I can walk you to a campus building, or tell you what's ahead.";
      case 'repeat_last':
        return this.lastSpoken || "I haven't said anything yet.";
      case 'set_quiet': {
        this.muted = action.argument !== 'off';
        if (this.muted) this.gate.clear('quiet_mode', (key) => !isNavKey(key) && !key.startsWith('hazard:'));
        return this.muted ? "Okay. I'll only speak for turns and urgent hazards." : "Okay, I'm talking again.";
      }
      case 'cancel_navigation':
        if (!this.nav) return "There's no route to cancel. I'm still watching the path.";
        this.endNavigation('cancelled');
        return "Navigation cancelled. I'm still watching the path.";
      case 'end_session':
        this.endScan();
        this.send({ type: 'end' });
        return 'Turning off. Goodbye.';
      case 'status':
        return this.statusLine();
      case 'how_far': {
        if (!this.nav) return "You're not on a route. Tell me where you'd like to go.";
        const toTurn = this.nav.distanceToNextTurn();
        const left = upperFirst(spokenDistance(this.nav.distanceRemaining()));
        return toTurn != null && toTurn < this.nav.distanceRemaining() - 15 ? `${left} to go. Next turn in ${spokenDistance(toTurn)}.` : `${left} to go.`;
      }
      case 'where_am_i': {
        const landmark = this.recentLandmark(null, 20_000);
        const near = landmark ? `You're near ${landmark.name}.` : '';
        if (this.nav) return `${near} On the way to ${this.destinationName}, ${spokenDistance(this.nav.distanceRemaining())} to go.`.trim();
        return near || "I don't see a building name right now. Point me at a sign and ask me to read it.";
      }
      case 'describe': {
        const frame = await this.freshFrame();
        return frame ? describeScene(frame.jpeg, signal) : NO_FRAME_LINE;
      }
      case 'read_text': {
        const frame = await this.freshFrame();
        return frame ? readText(frame.jpeg, signal) : NO_FRAME_LINE;
      }
      case 'find':
        return this.find(action.argument || 'object', signal);
      case 'start_navigation':
        return this.startNavigation(action.argument ?? '', signal);
    }
  }

  private statusLine(): string {
    const bad = Object.entries(allLinks()).filter(([id, s]) => (s.state === 'down' || s.state === 'off') && id !== 'L11');
    if (bad.length === 0) return 'All links are up.';
    const parts = bad.slice(0, 4).map(([id, s]) => `${LINK_NAMES[id as LinkId]} is ${s.state === 'off' ? 'not set up' : 'down'}`);
    return `${parts.join(', ')}. Everything else is up.`.replace(/^./, (c) => c.toUpperCase());
  }

  private async startNavigation(destinationText: string, signal?: AbortSignal): Promise<string> {
    if (!destinationText) return 'Where would you like to go?';
    const fix = this.lastFix;
    if (!fix || Date.now() - fix.receivedAt > 15_000) return "I don't have your location yet. Give me a moment outdoors, then ask again.";
    let resolved;
    try {
      resolved = await resolveDestination(destinationText, signal);
    } catch {
      return "I can't look up places right now.";
    }
    if (resolved.kind === 'ambiguous') return resolved.question;
    if (resolved.kind !== 'ok') return resolved.line;
    let route: Route;
    try {
      route = await computeWalkingRoute(fix, resolved.destination);
    } catch {
      return `I found ${resolved.spokenName}, but I couldn't get a walking route to it.`;
    }
    signal?.throwIfAborted();
    this.beginNavigation(route);
    return `Heading to ${resolved.spokenName}, ${spokenMinutes(route.durationS)} on foot.${resolved.note ? ` ${resolved.note}` : ''}`;
  }

  // ---------------------------------------------------------------- questions take a fresh frame

  /** Asks the phone for a burst now and waits for the next frame to arrive. Falls back to a recent one. */
  private freshFrame(timeoutMs = 2500): Promise<Frame | null> {
    const recent = () => (this.latestFrame && Date.now() - this.latestFrame.receivedAt < 3000 ? this.latestFrame : null);
    if (this.phone?.readyState !== WebSocket.OPEN) return Promise.resolve(recent());
    this.send({ type: 'capture' });
    return new Promise((resolve) => {
      const waiter = (f: Frame | null) => {
        clearTimeout(timer);
        resolve(f ?? recent());
      };
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w !== waiter);
        resolve(recent());
      }, timeoutMs);
      this.frameWaiters.push(waiter);
    });
  }

  private async find(object: string, signal?: AbortSignal): Promise<string> {
    this.endScan();
    const frame = await this.freshFrame();
    if (!frame) return NO_FRAME_LINE;
    this.geminiCalls++;
    const { boxes } = await findBoxes(frame.jpeg, object, signal);
    const line = findLine(object, boxes);
    const best = nearest(boxes);
    if (line && best) {
      // Keep guiding toward an object. Never toward a person.
      if (best.range !== 'here' && !isPerson(best)) this.startScan(object, 'guide', best);
      return line;
    }
    this.startScan(object, 'search', null);
    return "I don't see one. Turn slowly and I'll tell you when it's in view.";
  }

  private startScan(object: string, phase: Scan['phase'], prev: Located | null): void {
    const now = Date.now();
    this.scan = { id: ++this.scanCounter, object, phase, prev, until: now + (phase === 'search' ? SCAN_SEARCH_MS : SCAN_GUIDE_MS), lastCallAt: now, lastSaidAt: now, inFlight: false, lost: 0, said: 0 };
    this.send({ type: 'cadence', mode: 'scan' }); // a frame per second while looking
  }

  private endScan(): void {
    if (!this.scan) return;
    this.scan = null;
    this.send({ type: 'cadence', mode: 'walk' });
  }

  private finishScan(): void {
    const scan = this.scan;
    if (!scan) return;
    if (scan.phase === 'search') this.sayDirect(`find:${scan.id}:timeout`, "I still don't see one.");
    this.endScan();
  }

  private async onScanFrame(frame: Frame): Promise<void> {
    const scan = this.scan;
    const now = Date.now();
    if (!scan || scan.inFlight || now - scan.lastCallAt < 900) return;
    if (now > scan.until) return this.finishScan();
    scan.inFlight = true;
    scan.lastCallAt = now;
    try {
      this.geminiCalls++;
      const { boxes } = await findBoxes(frame.jpeg, scan.object);
      if (this.scan !== scan) return;
      const best = nearest(boxes);
      if (scan.phase === 'search') {
        if (!best) return;
        this.sayDirect(`find:${scan.id}:found`, findLine(scan.object, boxes)!);
        if (best.range === 'here' || isPerson(best)) return this.endScan();
        Object.assign(scan, { phase: 'guide', prev: best, until: Date.now() + SCAN_GUIDE_MS, lost: 0, lastSaidAt: Date.now() });
        return;
      }
      if (!best) {
        if (++scan.lost >= 4) this.endScan();
        return;
      }
      scan.lost = 0;
      const line = guidanceLine(scan.prev, best);
      const arrived = best.range === 'here';
      if (line && (arrived || (Date.now() - scan.lastSaidAt > 2500 && this.isQuiet()))) {
        this.sayDirect(`find:${scan.id}:g${++scan.said}`, upperFirst(line));
        scan.prev = best;
        scan.lastSaidAt = Date.now();
        if (arrived) this.endScan();
      }
    } catch {
      // logged in gemini.ts
    } finally {
      scan.inFlight = false;
    }
  }

  // ---------------------------------------------------------------- /debug

  debug() {
    const nav = this.nav;
    return {
      id: this.id,
      replay: this.replay,
      mode: this.mode,
      destination: this.destinationName,
      phoneConnected: this.phone?.readyState === WebSocket.OPEN,
      conversationId: this.conversationId,
      voice: this.voice,
      phoneStatus: this.phoneStatus,
      frames: this.frames,
      fixes: this.fixes,
      geminiCalls: this.geminiCalls,
      muted: this.muted,
      lastSpoken: this.lastSpoken,
      lastFix: this.lastFix,
      nav: nav && {
        generation: nav.generation,
        started: nav.started,
        step: nav.stepIndex,
        steps: nav.route.steps.map((s) => `${s.maneuver || '-'}: ${s.instruction} (${Math.round(s.distanceMeters)} m)`),
        along_m: Math.round(nav.along),
        off_route_m: Math.round(nav.distanceToRoute),
        to_next_turn_m: round(nav.distanceToNextTurn()),
        remaining_m: Math.round(nav.distanceRemaining()),
        handMarkedEntrance: nav.route.destination.handMarked,
      },
      scan: this.scan && { object: this.scan.object, phase: this.scan.phase },
      lastObservation: this.observations.at(-1) ?? null,
      gateDecisions: this.decisions.slice(-20),
    };
  }

  close(): void {
    this.recorder?.close();
    this.phone?.close();
  }
}

const round = (n: number | null) => (n == null ? null : Math.round(n));
const isNavKey = (key: string) => /^(depart|turn_ahead|turn_now|off_route|arrived|reassure|gps_poor|landmark):/.test(key);
const isPerson = (l: Located) => /\bperson\b/i.test(l.box.label);

// ---- registry ----

const sessions = new Map<string, Session>();

export function getOrCreateSession(id: string, opts: { replay?: boolean; record?: boolean } = {}): Session {
  let s = sessions.get(id);
  if (!s) {
    s = new Session(id, opts);
    sessions.set(id, s);
  }
  return s;
}

export const allSessions = () => [...sessions.values()];
export const connectedSessions = () => allSessions().filter((s) => s.phone?.readyState === WebSocket.OPEN);
export const sessionByConversation = (conversationId: string) => allSessions().find((s) => s.conversationId === conversationId) ?? null;

/** The most recently active live phone — the fallback pairing for L4 when `bind` hasn't matched. */
export function latestLiveSession(): Session | null {
  return (
    connectedSessions()
      .filter((s) => !s.replay)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0] ?? null
  );
}

/** Gate timer: queued lines wait for a pause, expire, and reassurance fires on silence. */
export function startSessionTimer(): NodeJS.Timeout {
  const t = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.phone?.readyState === WebSocket.OPEN) s.pump();
      else if (now - s.lastSeenAt > 30 * 60_000) {
        s.close();
        sessions.delete(s.id);
      }
    }
  }, 250);
  t.unref();
  return t;
}
