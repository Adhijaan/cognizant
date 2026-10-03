// L11: feed a recording through the same pipeline as a live phone (design.md §14).
//   npm run replay -- recordings/walk-1 --speed 2
//   npm run replay -- recordings/walk-1 --say "take me to Angell Hall" --audio
//
// --speed N   play N× faster (applies to frames, fixes and user turns alike: one timeline)
// --say TEXT  send a typed user turn before the recording starts (e.g. a destination)
// --audio     macOS: speak lines with `say` and play earcon clips with `afplay`
// --url URL   default ws://localhost:<PORT>/phone

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { config, ROOT_DIR } from '../src/config.ts';
import type { ServerToPhone } from '../src/protocol.ts';
import type { RecordedEvent } from '../src/recorder.ts';
import { die, fromInvocationDir } from './env-file.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueFlags = ['--speed', '--say', '--url'];
const dirArg = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
if (!dirArg) die('usage: npm run replay -- <recording dir> [--speed 2] [--say "take me to Angell Hall"] [--audio]');
const dir = fromInvocationDir(dirArg);
const eventsPath = path.join(dir, 'events.jsonl');
if (!fs.existsSync(eventsPath)) die(`[L11] no events.jsonl in ${dir}. Record a walk by opening the phone app with ?record=1.`);

const speed = Number(flag('--speed') ?? 1) || 1;
const audio = args.includes('--audio');
const url = flag('--url') ?? `ws://localhost:${config.port}/phone`;
const events: RecordedEvent[] = fs
  .readFileSync(eventsPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .sort((a, b) => a.t - b.t); // out-of-order timestamps put events at the wrong moments

const play = (cmd: string, cmdArgs: string[]) => audio && process.platform === 'darwin' && spawn(cmd, cmdArgs, { stdio: 'ignore' }).on('error', () => {});
const stamp = () => new Date().toISOString().slice(11, 23);

const ws = new WebSocket(url);
ws.on('error', (err) => die(`[L11] cannot connect to ${url}: ${err.message}. Is the server running?`));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString()) as ServerToPhone;
  if (msg.type === 'earcon') {
    console.log(`${stamp()} [L11] EARCON ${msg.clip}`);
    play('afplay', [path.join(ROOT_DIR, 'web', 'public', 'earcons', `${msg.clip}.mp3`)]);
  } else if (msg.type === 'speak') {
    console.log(`${stamp()} [L11] SPEAK  ${msg.key}: ${msg.text ?? ''}`);
    if (msg.text) play('say', [msg.text]);
  } else if (msg.type === 'session') {
    console.log(`${stamp()} [L11] session mode=${msg.mode} destination=${msg.destination ?? '-'}`);
  } else if (msg.type === 'error') {
    console.log(`${stamp()} [${msg.link}] error ${msg.message}`);
  }
});

ws.on('open', async () => {
  const session = `replay-${path.basename(dir)}-${Date.now().toString(36)}`;
  ws.send(JSON.stringify({ type: 'hello', session, replay: true, app: 'replay' }));
  console.log(`[L11] replaying ${events.length} events from ${dir} at ${speed}x as ${session}`);
  const say = flag('--say');
  const start = Date.now();
  let saidAt: number | null = say ? null : -1;
  for (const ev of events) {
    // A destination needs a fix first: send --say right after the first fix has gone out.
    const wait = ev.t / speed - (Date.now() - start);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (ws.readyState !== WebSocket.OPEN) break;
    const now = Date.now();
    if (ev.type === 'frame') {
      const jpeg = fs.readFileSync(path.join(dir, ev.file)).toString('base64');
      ws.send(JSON.stringify({ ...ev.msg, type: 'frame', jpeg, capturedAt: now }));
    } else if (ev.type === 'fix') {
      ws.send(JSON.stringify({ ...ev.msg, at: now }));
      if (say && saidAt === null) {
        saidAt = now;
        console.log(`${stamp()} [L11] SAY    ${say}`);
        ws.send(JSON.stringify({ type: 'say', text: say }));
      }
    } else {
      if (ev.type === 'say') console.log(`${stamp()} [L11] SAY    ${ev.msg.text}`);
      ws.send(JSON.stringify(ev.msg));
    }
  }
  // Let the last results and queued lines come back.
  await new Promise((r) => setTimeout(r, 6000));
  console.log('[L11] replay finished');
  ws.close();
  setTimeout(() => process.exit(0), 200);
});
