// L5: one frame through the obstacle schema; prints JSON + latency.
//   npm run test:vision -- fixtures/diag.jpg
//   npm run test:vision -- fixtures/room.jpg --find table
//   npm run test:vision -- fixtures/sign.jpg --read
//   npm run test:vision -- fixtures/room.jpg --describe

import fs from 'node:fs';
import { checkObstacles, describeScene, findBoxes, findLine, readText } from '../src/vision.ts';
import { die, fromInvocationDir } from './env-file.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--find');
if (!file) die('usage: npm run test:vision -- <image.jpg> [--find <object> | --describe | --read]');
const bytes = fs.readFileSync(fromInvocationDir(file));
if (bytes.length > 150 * 1024) console.log(`note: ${Math.round(bytes.length / 1024)} KB — the phone sends ~40–80 KB at 512 px; a bigger frame is slower`);
const jpeg = bytes.toString('base64');
const started = Date.now();

try {
  const findIndex = args.indexOf('--find');
  if (findIndex >= 0) {
    const object = args[findIndex + 1] ?? 'table';
    const { boxes } = await findBoxes(jpeg, object);
    console.log(JSON.stringify(boxes, null, 2));
    console.log(`line: ${findLine(object, boxes) ?? "I don't see one."}`);
  } else if (args.includes('--describe')) {
    console.log(await describeScene(jpeg));
  } else if (args.includes('--read')) {
    console.log(await readText(jpeg));
  } else {
    const { observation } = await checkObstacles(jpeg);
    console.log(JSON.stringify(observation, null, 2));
  }
  const ms = Date.now() - started;
  console.log(`latency: ${ms} ms${ms > 2000 ? '  (> 2 s: is thinking off? is the frame ≤ 512 px?)' : ''}`);
} catch {
  process.exit(1); // the failing call is already logged with status and body
}
