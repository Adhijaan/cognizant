import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { buildRoute, type Route } from '../src/nav/core.ts';
import type { LatLng } from '../src/nav/geo.ts';
import type { ServerToPhone } from '../src/protocol.ts';
import { Session } from '../src/session.ts';
import type { Observation } from '../src/vision.ts';

// End to end inside the server: fixes and observations in, phone messages out — through the real
// nav core and gate. Only the phone socket and the clock are fake.

const ORIGIN: LatLng = { lat: 42.277, lng: -83.738 };
const M_LAT = 111_320;
const M_LNG = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const at = (north: number, east: number): LatLng => ({ lat: ORIGIN.lat + north / M_LAT, lng: ORIGIN.lng + east / M_LNG });

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

function setup() {
  const sent: ServerToPhone[] = [];
  const session = new Session('test', { replay: true });
  session.phone = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)), close() {} } as never;
  const spoken = () => sent.filter((m) => m.type === 'speak').map((m) => (m.type === 'speak' ? m.text : ''));
  const earcons = () => sent.filter((m) => m.type === 'earcon').map((m) => (m.type === 'earcon' ? m.clip : ''));
  /** One second of walking: a fix, then the gate timer. */
  const step = (p: LatLng, accuracy = 8) => {
    session.handleFix({ type: 'fix', ...p, accuracy, heading: null, course: null, speed: 1.4, at: Date.now() });
    mock.timers.tick(1000);
    session.pump();
  };
  const walk = (from: [number, number], to: [number, number]) => {
    const n = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 1.4);
    for (let i = 0; i <= n; i++) step(at(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n));
  };
  const begin = (route = lRoute()) => (session as unknown as { beginNavigation(r: Route): void }).beginNavigation(route);
  return { session, sent, spoken, earcons, step, walk, begin };
}

const observation = (over: Partial<Observation> = {}): Observation => ({ usable: true, obstacles: [], landmarks: [], visible_text: [], ...over });
const bike = (distance: 'near' | 'mid'): Observation => observation({ obstacles: [{ type: 'bike', position: 'left', distance, in_path: true }] });

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1_790_000_000_000 }));
afterEach(() => mock.timers.reset());

test('a walk to the entrance: every line once, in order, then back to helping', () => {
  const { session, spoken, sent, step, walk, begin } = setup();
  step(at(0, 0));
  begin();
  assert.equal(session.mode, 'navigating');
  walk([0, 0], [200, 0]);
  walk([200, 0], [200, 100]);
  walk([200, 100], [260, 100]);
  for (let i = 0; i < 6; i++) step(at(260, 100));
  assert.deepEqual(spoken(), [
    'Head north.',
    'Still on track. About 400 feet to the next turn.',
    'In about 150 feet, turn right.',
    'Turn right now.',
    'In about 150 feet, turn left onto South State Street.',
    'Turn left now.',
    "You're at the Angell Hall entrance. I can help you find things inside.",
  ]);
  assert.equal(session.mode, 'helping');
  assert.equal(session.nav, null);
  assert.deepEqual(sent.filter((m) => m.type === 'session').map((m) => (m.type === 'session' ? m.mode : '')), ['navigating', 'helping']);
});

test('proactive lines round-trip through the [nav:key] tag with no model call', async () => {
  const { session, sent, step, begin } = setup();
  step(at(0, 0));
  begin();
  step(at(1, 0));
  const speak = sent.find((m) => m.type === 'speak');
  assert.ok(speak?.type === 'speak');
  assert.equal(await session.handleUserTurn(`[nav:${speak.key}]`), 'Head north.');
  assert.equal(await session.handleUserTurn('[nav:nope]'), '');
  assert.equal(await session.handleUserTurn('repeat that'), 'Head north.');
});

test('user talking through the turn-ahead window: it is dropped, turn now still comes', () => {
  const { session, spoken, walk, step, begin } = setup();
  step(at(0, 0));
  begin();
  walk([0, 0], [150, 0]);
  session.handleVoice({ type: 'voice', agentSpeaking: false, userSpeaking: true, connected: true });
  walk([150, 0], [193, 0]);
  session.handleVoice({ type: 'voice', agentSpeaking: false, userSpeaking: false, connected: true });
  walk([193, 0], [200, 0]);
  const lines = spoken();
  assert.ok(!lines.some((l) => l?.startsWith('In about')));
  assert.equal(lines.at(-1), 'Turn right now.');
  assert.ok(session.decisions.some((d) => d.key === 'turn_ahead:1-1' && d.action === 'drop' && d.reason === 'stale'));
});

test('near obstacle: earcon at once even while the user talks, said once across five frames', () => {
  const { session, earcons, spoken } = setup();
  session.handleVoice({ type: 'voice', agentSpeaking: false, userSpeaking: true, connected: true });
  for (let i = 0; i < 5; i++) {
    session.ingestObservation(bike('near'));
    mock.timers.tick(1500);
  }
  assert.deepEqual(earcons(), ['obstacle_left']);
  assert.deepEqual(spoken(), []); // the spoken detail waited for a pause and expired
});

test('mid obstacle is spoken at the next pause; people walking are never mentioned', () => {
  const { session, earcons, spoken } = setup();
  session.ingestObservation(observation({ obstacles: [{ type: 'person_stopped', position: 'center', distance: 'far', in_path: true }] }));
  session.ingestObservation(bike('mid'));
  assert.deepEqual(earcons(), []);
  assert.deepEqual(spoken(), ['Bike ahead, on your left.']);
});

test('a covered camera is reported after several unusable frames, at most every 2 minutes', () => {
  const { session, spoken } = setup();
  for (let i = 0; i < 12; i++) {
    session.ingestObservation(observation({ usable: false }));
    mock.timers.tick(2000);
    session.pump();
  }
  assert.deepEqual(spoken(), ['The camera looks covered.']);
});

test('cancel keeps helping and forgets queued turns; quiet mode drops optional lines', async () => {
  const { session, spoken, step, begin } = setup();
  step(at(0, 0));
  begin();
  assert.equal(await session.handleUserTurn('stop navigation'), "Navigation cancelled. I'm still watching the path.");
  assert.equal(session.mode, 'helping');
  await session.handleUserTurn('quiet');
  mock.timers.tick(5000);
  session.ingestObservation(bike('mid'));
  session.pump();
  assert.ok(!spoken().includes('Bike ahead, on your left.'));
});

test('a turn line that waited for a pause gives the distance as it is when spoken', () => {
  const { session, spoken, walk, step, begin } = setup();
  step(at(0, 0));
  begin();
  walk([0, 0], [150, 0]);
  session.handleVoice({ type: 'voice', agentSpeaking: true, userSpeaking: false, connected: true });
  walk([150, 0], [180, 0]);
  session.handleVoice({ type: 'voice', agentSpeaking: false, userSpeaking: false, connected: true });
  step(at(181, 0));
  assert.equal(spoken().at(-1), 'In about 50 feet, turn right.');
});
