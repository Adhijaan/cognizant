import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fastPath, safeReply } from '../src/conversation.ts';
import { isNorthCampus, matchNickname, stripRoom } from '../src/destination.ts';
import { cleanInstruction, clockPosition, earconFor, obstacleLine, spokenDistance, spokenMinutes } from '../src/lines.ts';
import { NAV_TAG_RE, navTag } from '../src/protocol.ts';
import { findLine, guidanceLine, locate, type Box } from '../src/vision.ts';

test('distances: feet rounded to 50, steps when close', () => {
  assert.equal(spokenDistance(40), 'about 150 feet');
  assert.equal(spokenDistance(100), 'about 350 feet');
  assert.equal(spokenDistance(16), 'about 50 feet');
  assert.equal(spokenDistance(9), 'about 12 steps');
  assert.equal(spokenDistance(2), 'a few steps');
  assert.equal(spokenMinutes(350), 'about six minutes');
  assert.equal(spokenMinutes(20), 'about one minute');
});

test('clock positions: 30 degrees per hour', () => {
  assert.equal(clockPosition(0), 'straight ahead');
  assert.equal(clockPosition(5), 'straight ahead');
  assert.equal(clockPosition(11), 'slightly to your right');
  assert.equal(clockPosition(-11), 'slightly to your left');
  assert.equal(clockPosition(28), "at your one o'clock");
  assert.equal(clockPosition(-62), "at your ten o'clock");
  assert.equal(clockPosition(95), "at your three o'clock");
  assert.equal(clockPosition(178), 'behind you');
});

test('instructions are cleaned for speech', () => {
  assert.equal(cleanInstruction('Turn right onto S State St\nDestination will be on the left'), 'Turn right onto South State Street');
  assert.equal(cleanInstruction('Head <b>north</b> on N University Ave.'), 'Head north on North University Avenue');
});

test('obstacle wording and earcon choice', () => {
  assert.equal(obstacleLine('bike', 'left'), 'Bike ahead, on your left.');
  assert.equal(obstacleLine('construction', 'center'), 'Construction fencing ahead.');
  assert.equal(earconFor('stairs', 'left'), 'stairs_ahead');
  assert.equal(earconFor('closed_path', 'center'), 'stop');
  assert.equal(earconFor('bike', 'left'), 'obstacle_left');
  assert.equal(earconFor('pole', 'center'), 'obstacle_ahead');
});

const box = (ymin: number, xmin: number, ymax: number, xmax: number, label = 'table'): Box => ({ label, box_2d: [ymin, xmin, ymax, xmax] });

test('find: angle from box center and horizontal FOV', () => {
  assert.equal(locate(box(400, 450, 600, 550), 60).angle, 0);
  assert.ok(Math.abs(locate(box(400, 900, 600, 1000), 60).angle - 27) < 1e-9);
  assert.equal(locate(box(400, 900, 600, 1000), 60).direction, "at your one o'clock");
  assert.equal(locate(box(400, 0, 600, 100), 60).direction, "at your eleven o'clock");
});

test('find: one match, several matches, right in front, not in view', () => {
  assert.equal(findLine('table', [box(300, 850, 500, 1000)], 60), "The table is at your one o'clock, farther ahead.");
  assert.equal(findLine('table', [box(200, 100, 350, 250), box(500, 800, 800, 1000)], 60), "Two tables; the closest is at your one o'clock, a few steps away.");
  assert.equal(findLine('table', [box(450, 200, 990, 800)], 60), 'The table should be right in front of you.');
  assert.equal(findLine('table', [], 60), null);
});

test('find: people are only ever "a person"', () => {
  assert.equal(findLine('my friend Sam', [box(300, 0, 800, 150, 'person')], 60), "A person is at your eleven o'clock, a few steps away.");
});

test('find: guidance speaks only when direction or range changes', () => {
  const far = locate(box(300, 700, 450, 800), 60);
  const sameFar = locate(box(300, 710, 450, 810), 60);
  const closeLeft = locate(box(400, 300, 800, 420), 60);
  const here = locate(box(450, 200, 990, 800), 60);
  assert.equal(guidanceLine(far, sameFar), null);
  assert.equal(guidanceLine(far, closeLeft), 'slightly left, closer now.');
  assert.equal(guidanceLine(closeLeft, here), 'It should be right in front of you.');
});

test('destinations: nicknames, fuzzy matches, North Campus, room numbers', () => {
  assert.equal(matchNickname('the Ugli')?.query, 'Shapiro Undergraduate Library');
  assert.equal(matchNickname('the grad')?.query, 'Hatcher Graduate Library');
  assert.equal(matchNickname('The Fishbowl')?.query, 'Angell Hall');
  assert.equal(matchNickname('fishbole')?.query, 'Angell Hall');
  assert.equal(matchNickname('angel hall')?.query, 'Angell Hall');
  assert.equal(matchNickname('Mason Hall'), null);
  assert.equal(isNorthCampus('take me to the Dude'), true);
  assert.equal(isNorthCampus('BBB'), true);
  assert.equal(isNorthCampus('the Union'), false);
  assert.deepEqual(stripRoom('Angell Hall room 2225'), { text: 'Angell Hall', hadRoom: true });
  assert.deepEqual(stripRoom('Mason Hall 1437'), { text: 'Mason Hall', hadRoom: true });
  assert.deepEqual(stripRoom('the Union'), { text: 'the Union', hadRoom: false });
});

test('voice commands that need no model', () => {
  assert.deepEqual(fastPath('Repeat that.'), { action: 'repeat_last' });
  assert.deepEqual(fastPath('quiet'), { action: 'set_quiet', argument: 'on' });
  assert.deepEqual(fastPath('Talk again'), { action: 'set_quiet', argument: 'off' });
  assert.deepEqual(fastPath('stop navigation'), { action: 'cancel_navigation' });
  assert.deepEqual(fastPath('Cancel.'), { action: 'cancel_navigation' });
  assert.deepEqual(fastPath('turn off'), { action: 'end_session' });
  assert.deepEqual(fastPath('Status'), { action: 'status' });
  assert.deepEqual(fastPath('How far?'), { action: 'how_far' });
  assert.equal(fastPath('take me to the Union'), null);
  assert.equal(fastPath("where's the table"), null);
});

test('never "safe to cross"', () => {
  assert.equal(safeReply('It is safe to cross now.'), "I can't tell you when to cross. I can tell you what I see.");
  assert.equal(safeReply("You're at the State Street crosswalk."), "You're at the State Street crosswalk.");
});

test('nav tags round-trip, including merged keys', () => {
  assert.equal(NAV_TAG_RE.exec(navTag('turn_now:3+arrived:angell hall:1'))?.[1], 'turn_now:3+arrived:angell hall:1');
  assert.equal(NAV_TAG_RE.exec('take me to [nav:x]'), null);
});
