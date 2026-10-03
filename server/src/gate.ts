// Event gate: plain code, deterministic (design.md §8). Silence is the default.
// Events come in with stable keys; each key is spoken at most once (or once per cooldown).
// Only priority 1 interrupts. Everything else waits until user and agent are both quiet,
// expires if it waits too long, and is spaced at least 4 s apart.

import type { EarconClip } from './protocol.ts';
import { lowerFirst, sentence } from './lines.ts';

export interface GateEvent {
  key: string;
  /** 1 = urgent (earcon, interrupts) … 8 = optional. */
  priority: number;
  /** A function is evaluated when the line is finally spoken, so a line that waited says the current distance. */
  text: string | (() => string);
  /** Priority 1 only: the clip the phone plays. */
  earcon?: EarconClip;
  /** Drop if not said within this long. null = never expires. */
  ttlMs: number | null;
  /** Drop when this turns true (e.g. the step was passed). */
  stale?: () => boolean;
  /** How long before the same key may be said again. Default: never again. */
  cooldownMs?: number;
  /** Nav lines that may be joined with a neighbour: "turn right, then the entrance is on your left". */
  mergeable?: boolean;
}

export interface Emission {
  kind: 'earcon' | 'speak';
  /** For merged lines, the keys joined with "+". */
  key: string;
  keys: string[];
  text: string;
  clip?: EarconClip;
  priority: number;
}

export interface GateDecision {
  at: number;
  key: string;
  action: 'queue' | 'emit' | 'drop';
  reason?: string;
  priority: number;
  text?: string;
}

export interface GateContext {
  /** User and agent are both quiet, and no reply is in flight. */
  quiet: boolean;
  /** "Quiet" mode: the user asked for less talk. Optional lines (priority ≥ 6) are dropped. */
  muted: boolean;
}

export const GATE = {
  minGapMs: 4000,
  mergeWindowMs: 5000,
  mutedFromPriority: 6,
};

interface Queued extends GateEvent {
  offeredAt: number;
}

const textOf = (ev: GateEvent) => (typeof ev.text === 'function' ? ev.text() : ev.text);

export class Gate {
  private queue = new Map<string, Queued>();
  private spoken = new Map<string, { at: number; priority: number }>();
  private lastLineAt = -Infinity;
  private now: () => number;
  private onDecision: (d: GateDecision) => void;

  constructor(opts: { now?: () => number; onDecision?: (d: GateDecision) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.onDecision = opts.onDecision ?? (() => {});
  }

  private decide(ev: GateEvent, action: GateDecision['action'], reason?: string): void {
    this.onDecision({ at: this.now(), key: ev.key, action, reason, priority: ev.priority, text: action === 'drop' ? undefined : textOf(ev) });
  }

  offer(ev: GateEvent, ctx: Pick<GateContext, 'muted'> = { muted: false }): void {
    const now = this.now();
    const prior = this.spoken.get(ev.key);
    if (prior) {
      const cooling = now - prior.at < (ev.cooldownMs ?? Infinity);
      // A more urgent version of the same thing (mid → near) is new information.
      if (cooling && ev.priority >= prior.priority) return this.decide(ev, 'drop', 'duplicate');
    }
    if (ctx.muted && ev.priority >= GATE.mutedFromPriority) return this.decide(ev, 'drop', 'quiet_mode');
    const queued = this.queue.get(ev.key);
    if (queued) {
      // Same event seen again while waiting: keep its place in line, refresh the wording.
      if (ev.priority <= queued.priority) this.queue.set(ev.key, { ...ev, offeredAt: queued.offeredAt });
      return;
    }
    this.queue.set(ev.key, { ...ev, offeredAt: now });
    this.decide(ev, 'queue');
  }

  /** The user's own question was just answered, or anything else was spoken: hold non-urgent lines for a beat. */
  noteSpeech(at = this.now()): void {
    this.lastLineAt = at;
  }

  /** Forget everything waiting (navigation cancelled, session ending). */
  clear(reason: string, match: (key: string) => boolean = () => true): void {
    for (const ev of [...this.queue.values()]) {
      if (!match(ev.key)) continue;
      this.queue.delete(ev.key);
      this.decide(ev, 'drop', reason);
    }
  }

  pending(): number {
    return this.queue.size;
  }

  tick(ctx: GateContext): Emission[] {
    const now = this.now();
    const out: Emission[] = [];

    for (const ev of [...this.queue.values()]) {
      const expired = ev.ttlMs !== null && now - ev.offeredAt > ev.ttlMs;
      if (expired || ev.stale?.()) {
        this.queue.delete(ev.key);
        this.decide(ev, 'drop', expired ? 'expired' : 'stale');
      }
    }

    const ordered = [...this.queue.values()].sort((a, b) => a.priority - b.priority || a.offeredAt - b.offeredAt);

    // Priority 1: earcon now, whoever is talking.
    for (const ev of ordered.filter((e) => e.priority === 1)) {
      this.queue.delete(ev.key);
      this.spoken.set(ev.key, { at: now, priority: ev.priority });
      this.decide(ev, 'emit');
      out.push({ kind: 'earcon', key: ev.key, keys: [ev.key], text: textOf(ev), clip: ev.earcon, priority: 1 });
    }

    if (!ctx.quiet || now - this.lastLineAt < GATE.minGapMs) return out;

    const head = ordered.find((e) => e.priority > 1);
    if (!head) return out;
    const group = [head];
    if (head.mergeable) {
      const mate = ordered.find((e) => e !== head && e.priority > 1 && e.mergeable && Math.abs(e.offeredAt - head.offeredAt) <= GATE.mergeWindowMs);
      if (mate) group.push(mate);
    }
    for (const ev of group) {
      this.queue.delete(ev.key);
      this.spoken.set(ev.key, { at: now, priority: ev.priority });
      this.decide(ev, 'emit', group.length > 1 ? 'merged' : undefined);
    }
    this.lastLineAt = now;
    const [first, second] = group.map(textOf);
    const text = second === undefined ? sentence(first) : sentence(`${first.replace(/[.?!]$/, '')}, then ${lowerFirst(second)}`);
    out.push({ kind: 'speak', key: group.map((e) => e.key).join('+'), keys: group.map((e) => e.key), text, priority: head.priority });
    return out;
  }
}
