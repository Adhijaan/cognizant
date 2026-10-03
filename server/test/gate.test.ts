import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gate, type GateDecision, type GateEvent } from '../src/gate.ts';

function setup() {
  let now = 1_000_000;
  const decisions: GateDecision[] = [];
  const gate = new Gate({ now: () => now, onDecision: (d) => decisions.push(d) });
  return { gate, decisions, advance: (ms: number) => (now += ms) };
}
const quiet = { quiet: true, muted: false };
const busy = { quiet: false, muted: false };
const hazardNear = (over: Partial<GateEvent> = {}): GateEvent => ({ key: 'hazard:bike:center', priority: 1, text: 'Bike ahead.', earcon: 'obstacle_ahead', ttlMs: 3000, cooldownMs: 20_000, ...over });
const turnAhead = (over: Partial<GateEvent> = {}): GateEvent => ({ key: 'turn_ahead:1', priority: 4, text: 'In about 150 feet, turn right', ttlMs: null, mergeable: true, ...over });

test('silence is the default', () => {
  const { gate } = setup();
  assert.deepEqual(gate.tick(quiet), []);
});

test('same obstacle in five frames is said once', () => {
  const { gate, decisions, advance } = setup();
  const out = [];
  for (let i = 0; i < 5; i++) {
    gate.offer(hazardNear());
    out.push(...gate.tick(quiet));
    advance(1500);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'earcon');
  assert.equal(out[0].clip, 'obstacle_ahead');
  assert.equal(decisions.filter((d) => d.action === 'drop' && d.reason === 'duplicate').length, 4);
});

test('hazard cooldown: the same key may fire again after 20 s', () => {
  const { gate, advance } = setup();
  gate.offer(hazardNear());
  assert.equal(gate.tick(quiet).length, 1);
  advance(21_000);
  gate.offer(hazardNear());
  assert.equal(gate.tick(quiet).length, 1);
});

test('mid then near for the same obstacle escalates to an earcon', () => {
  const { gate, advance } = setup();
  gate.offer(hazardNear({ priority: 6, earcon: undefined, ttlMs: 5000 }));
  assert.equal(gate.tick(quiet)[0].kind, 'speak');
  advance(3000);
  gate.offer(hazardNear());
  assert.equal(gate.tick(quiet)[0]?.kind, 'earcon');
});

test('user talking when a turn comes: it waits, a hazard still interrupts', () => {
  const { gate, advance } = setup();
  gate.offer(turnAhead());
  gate.offer(hazardNear());
  const during = gate.tick(busy);
  assert.deepEqual(during.map((e) => e.kind), ['earcon']);
  advance(1000);
  const after = gate.tick(quiet);
  assert.deepEqual(after.map((e) => e.key), ['turn_ahead:1']);
});

test('a turn queued behind a long answer expires', () => {
  const { gate, decisions, advance } = setup();
  let passed = false;
  gate.offer({ key: 'turn_now:2', priority: 2, text: 'Turn left now', ttlMs: null, stale: () => passed });
  gate.offer({ key: 'off_route:1', priority: 3, text: 'Rerouting', ttlMs: 10_000 });
  advance(12_000);
  passed = true;
  assert.deepEqual(gate.tick(quiet), []);
  assert.deepEqual(decisions.filter((d) => d.action === 'drop').map((d) => `${d.key}:${d.reason}`).sort(), ['off_route:1:expired', 'turn_now:2:stale']);
});

test('nearby nav events merge into one sentence', () => {
  const { gate, advance } = setup();
  gate.offer({ key: 'turn_now:3', priority: 2, text: 'Turn right now', ttlMs: null, mergeable: true });
  advance(2000);
  gate.offer({ key: 'arrived:angell hall', priority: 5, text: 'The entrance is on your left', ttlMs: null, mergeable: true });
  const out = gate.tick(quiet);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Turn right now, then the entrance is on your left.');
  assert.deepEqual(out[0].keys, ['turn_now:3', 'arrived:angell hall']);
  assert.equal(out[0].key, 'turn_now:3+arrived:angell hall');
});

test('events more than 5 s apart do not merge', () => {
  const { gate, advance } = setup();
  gate.offer(turnAhead());
  advance(6000);
  gate.offer({ key: 'turn_now:1', priority: 2, text: 'Turn right now', ttlMs: null, mergeable: true });
  const out = gate.tick(quiet);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'turn_now:1');
});

test('at most one non-urgent line per 4 s, highest priority first', () => {
  const { gate, advance } = setup();
  gate.offer({ key: 'landmark:hatcher', priority: 7, text: 'Hatcher Graduate Library on your left', ttlMs: 10_000 });
  gate.offer({ key: 'off_route:1', priority: 3, text: 'Rerouting', ttlMs: 10_000 });
  assert.deepEqual(gate.tick(quiet).map((e) => e.key), ['off_route:1']);
  advance(2000);
  assert.deepEqual(gate.tick(quiet), []);
  advance(2100);
  assert.deepEqual(gate.tick(quiet).map((e) => e.key), ['landmark:hatcher']);
});

test('an answer to the user holds non-urgent lines for a beat', () => {
  const { gate, advance } = setup();
  gate.noteSpeech();
  gate.offer(turnAhead());
  assert.deepEqual(gate.tick(quiet), []);
  advance(4100);
  assert.equal(gate.tick(quiet).length, 1);
});

test('each nav key is spoken at most once', () => {
  const { gate, advance } = setup();
  gate.offer(turnAhead());
  assert.equal(gate.tick(quiet).length, 1);
  advance(60_000);
  gate.offer(turnAhead());
  assert.deepEqual(gate.tick(quiet), []);
});

test('quiet mode drops optional lines but keeps turns and urgent hazards', () => {
  const { gate, decisions } = setup();
  const muted = { muted: true };
  gate.offer({ key: 'landmark:hatcher', priority: 7, text: 'Hatcher on your left', ttlMs: 10_000 }, muted);
  gate.offer(turnAhead(), muted);
  gate.offer(hazardNear(), muted);
  const out = gate.tick({ quiet: true, muted: true });
  assert.deepEqual(out.map((e) => e.key).sort(), ['hazard:bike:center', 'turn_ahead:1']);
  assert.ok(decisions.some((d) => d.key === 'landmark:hatcher' && d.reason === 'quiet_mode'));
});

test('every decision is logged, drops with a reason', () => {
  const { gate, decisions, advance } = setup();
  gate.offer({ key: 'reassure:1', priority: 8, text: 'Still on track', ttlMs: 10_000 });
  advance(11_000);
  gate.tick(busy);
  assert.deepEqual(decisions.map((d) => [d.key, d.action, d.reason]), [
    ['reassure:1', 'queue', undefined],
    ['reassure:1', 'drop', 'expired'],
  ]);
});

test('clear drops only matching keys', () => {
  const { gate } = setup();
  gate.offer(turnAhead());
  gate.offer({ key: 'camera_covered', priority: 8, text: 'The camera looks covered', ttlMs: 10_000 });
  gate.clear('navigation_cancelled', (k) => k.startsWith('turn_'));
  assert.deepEqual(gate.tick(quiet).map((e) => e.key), ['camera_covered']);
});
