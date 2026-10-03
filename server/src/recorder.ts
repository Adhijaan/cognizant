// Recording for replay (design.md §14). Team walks only: this is the one place frames touch disk.
// Layout: <REPLAY_DIR>/<session>/events.jsonl + frames/000123.jpg. One timeline for frames, fixes
// and user turns, so replay speed applies to all of them equally.

import fs from 'node:fs';
import path from 'node:path';
import type { FixMsg, FrameMsg, SayMsg, StatusMsg } from './protocol.ts';

export type RecordedEvent =
  | { t: number; type: 'frame'; file: string; msg: Omit<FrameMsg, 'jpeg'> }
  | { t: number; type: 'fix'; msg: FixMsg }
  | { t: number; type: 'status'; msg: StatusMsg }
  | { t: number; type: 'say'; msg: SayMsg };

export class Recorder {
  readonly dir: string;
  private stream: fs.WriteStream;
  private start = Date.now();

  constructor(baseDir: string, session: string) {
    this.dir = path.join(baseDir, session.replace(/[^\w.-]+/g, '_'));
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, 'events.jsonl'), { flags: 'a' });
  }

  private write(ev: object): void {
    this.stream.write(JSON.stringify({ t: Date.now() - this.start, ...ev }) + '\n');
  }

  frame(msg: FrameMsg): void {
    const file = `frames/${String(msg.seq).padStart(6, '0')}.jpg`;
    fs.writeFile(path.join(this.dir, file), Buffer.from(msg.jpeg, 'base64'), () => {});
    const { jpeg: _jpeg, ...rest } = msg;
    this.write({ type: 'frame', file, msg: rest });
  }

  fix(msg: FixMsg): void {
    this.write({ type: 'fix', msg });
  }

  status(msg: StatusMsg): void {
    this.write({ type: 'status', msg });
  }

  /** A user turn heard over L4, so the replay can ask for the same things. */
  say(text: string): void {
    this.write({ type: 'say', msg: { type: 'say', text } });
  }

  close(): void {
    this.stream.end();
  }
}
