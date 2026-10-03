import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoute, NavCore, type Fix, type NavEvent, type Route } from '../src/nav/core.ts';
import { angleDiff, bearing, cumulative, decodePolyline, encodePolyline, haversine, snapToPolyline, type LatLng } from '../src/nav/geo.ts';

// A flat test world near the Diag: move a point by meters north/east.
const ORIGIN: LatLng = { lat: 42.277, lng: -83.738 };
const M_LAT = 111_320;
const M_LNG = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const at = (north: number, east: number): LatLng => ({ lat: ORIGIN.lat + north / M_LAT, lng: ORIGIN.lng + east / M_LNG });

/** 200 m north, right turn, 100 m east, left turn, 60 m north to the entrance. */
function lRoute(): Route {
  const points = [at(0, 0), at(200, 0), at(200, 100), at(260, 100)];
  return buildRoute(
    points,
    [
      { instruction: 'Head north', maneuver: 'DEPART', distanceMeters: 200, end: points[1] },
      { instruction: 'Turn right', maneuver: 'TURN_RIGHT', distanceMeters: 100, end: points[2] },
      { instruction: 'Turn left onto South State Street', maneuver: 'TURN_LEFT', distanceMeters: 60, end: points[3] },
    ],
    280,
    { name: 'Angell Hall', entrance: points[3], handMarked: true },
  );
}

const fix = (p: LatLng, accuracy = 8, t = 0): Fix => ({ ...p, accuracy, at: t });

function walk(nav: NavCore, path: LatLng[], opts: { accuracy?: number; startT?: number } = {}): NavEvent[] {
  const events: NavEvent[] = [];
  let t = opts.startT ?? 0;
  for (const p of path) {
    events.push(...nav.update(fix(p, opts.accuracy ?? 8, t), t));
    t += 1000;
  }
  return events;
}

const line = (from: [number, number], to: [number, number], stepM = 1.4): LatLng[] => {
  const n = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / stepM));
  return Array.from({ length: n + 1 }, (_, i) => at(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n));
};

test('geo: haversine, bearing, angleDiff, polyline round trip', () => {
  assert.ok(Math.abs(haversine(at(0, 0), at(100, 0)) - 100) < 0.5);
  assert.ok(Math.abs(bearing(at(0, 0), at(0, 100)) - 90) < 0.5);
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
  const pts = [at(0, 0), at(200, 0), at(200, 100)];
  const decoded = decodePolyline(encodePolyline(pts));
  decoded.forEach((p, i) => assert.ok(haversine(p, pts[i]) < 1.5));
  // Google's documented example
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('geo: snap reports distance along and off the line', () => {
  const pts = [at(0, 0), at(200, 0), at(200, 100)];
  const snap = snapToPolyline(at(120, 9), pts, cumulative(pts))!;
  assert.ok(Math.abs(snap.along - 120) < 1);
  assert.ok(Math.abs(snap.dist - 9) < 0.5);
});

test('buildRoute places steps along the polyline', () => {
  const r = lRoute();
  assert.ok(Math.abs(r.length - 360) < 1);
  assert.deepEqual(r.steps.map((s) => Math.round(s.startAlong)), [0, 200, 300]);
});

test('no instruction until accuracy is under 25 m', () => {
  const nav = new NavCore(lRoute());
  assert.deepEqual(nav.update(fix(at(0, 0), 60), 0), []);
  assert.deepEqual(nav.update(fix(at(1, 0), 30), 1000), []);
  assert.deepEqual(nav.update(fix(at(2, 0), 12), 2000).map((e) => e.kind), ['depart']);
});

test('a full walk: depart, turn ahead and turn now once each per turn, then arrival', () => {
  const nav = new NavCore(lRoute());
  const events = walk(nav, [...line([0, 0], [200, 0]), ...line([200, 0], [200, 100]), ...line([200, 100], [260, 100])]);
  assert.deepEqual(
    events.map((e) => (e.kind === 'turn_ahead' || e.kind === 'turn_now' ? `${e.kind}:${e.step}` : e.kind)),
    ['depart', 'turn_ahead:1', 'turn_now:1', 'turn_ahead:2', 'turn_now:2', 'arrived'],
  );
  const ahead = events.find((e) => e.kind === 'turn_ahead')!;
  assert.ok(ahead.kind === 'turn_ahead' && ahead.distance <= 40 && ahead.distance > 37);
  assert.equal(nav.arrived, true);
});

test('thresholds fire on crossing only: jitter back across the line does not re-fire', () => {
  const nav = new NavCore(lRoute());
  const events = walk(nav, [at(0, 0), at(150, 0), at(162, 0), at(158, 2), at(163, -2), at(157, 0), at(165, 0)]);
  assert.equal(events.filter((e) => e.kind === 'turn_ahead').length, 1);
});

test('poor accuracy: turn now is landmark-only', () => {
  const nav = new NavCore(lRoute());
  walk(nav, [at(0, 0), at(150, 0)]);
  const events = nav.update(fix(at(193, 0), 22), 5000);
  assert.deepEqual(events, [{ kind: 'turn_now', step: 1, landmarkOnly: true }]);
});

test('off route after 3 consecutive far fixes; rerouting at most once per 20 s', () => {
  const nav = new NavCore(lRoute());
  walk(nav, [at(0, 0), at(50, 0)]);
  const off = walk(nav, [at(60, 40), at(62, 42), at(64, 44), at(66, 46), at(68, 48)], { startT: 2000 });
  assert.deepEqual(off, [{ kind: 'off_route', n: 1, reroute: true }]);
  // still off 10 s later: no second reroute yet
  assert.deepEqual(walk(nav, [at(70, 50), at(72, 52)], { startT: 12_000 }), []);
  // 25 s after the first: same episode, a second reroute is allowed
  assert.deepEqual(walk(nav, [at(74, 54)], { startT: 30_000 }), [{ kind: 'off_route', n: 1, reroute: true }]);
});

test('jitter near the route edge does not trigger off route', () => {
  const nav = new NavCore(lRoute());
  walk(nav, [at(0, 0), at(50, 0)]);
  const events = walk(nav, [at(52, 28), at(54, 10), at(56, 29), at(58, 5), at(60, 30), at(62, 8)], { startT: 2000 });
  assert.equal(events.filter((e) => e.kind === 'off_route').length, 0);
});

test('a fix whose accuracy radius reaches the line is not off route', () => {
  const nav = new NavCore(lRoute());
  walk(nav, [at(0, 0), at(50, 0)]);
  const events = walk(nav, [at(55, 35), at(57, 35), at(59, 35), at(61, 35)], { accuracy: 45, startT: 2000 });
  assert.equal(events.filter((e) => e.kind === 'off_route').length, 0);
});

test('arrival needs good accuracy or vision confirming the building', () => {
  const nav = new NavCore(lRoute());
  walk(nav, [at(0, 0), at(200, 50)]);
  walk(nav, [at(245, 100)], { accuracy: 30, startT: 2000 });
  assert.equal(nav.arrived, false);
  assert.deepEqual(nav.update(fix(at(250, 100), 30), 9000).filter((e) => e.kind === 'arrived'), []);
  assert.deepEqual(nav.update(fix(at(251, 100), 30), 10_000, { sawDestination: true }).map((e) => e.kind), ['arrived']);
});

test('gps poor is reported once per stretch', () => {
  const nav = new NavCore(lRoute());
  walk(nav, [at(0, 0)]);
  const poor = walk(nav, line([2, 0], [20, 0]), { accuracy: 40, startT: 1000 });
  assert.equal(poor.filter((e) => e.kind === 'gps_poor').length, 1);
  walk(nav, [at(22, 0)], { startT: 30_000 });
  const again = walk(nav, line([24, 0], [40, 0]), { accuracy: 40, startT: 31_000 });
  assert.equal(again.filter((e) => e.kind === 'gps_poor').length, 1);
});

test('reroute installs a new route with fresh step ids', () => {
  const nav = new NavCore(lRoute(), 1);
  assert.equal(nav.stepId(2), '1-2');
  nav.setRoute(lRoute(), 2);
  assert.equal(nav.stepId(2), '2-2');
  assert.equal(new NavCore(lRoute()).stepId(2), '2');
});
