import type { LinkId, LinkState, LinkStatus } from './protocol.ts';

// Every log line starts with its link ID, then key=value (design.md §15).
//   [L5] obstacle ms=812 usable=true obstacles=1

export type Tag = LinkId | 'gate' | 'nav' | 'server' | 'cost';

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 5 : 1).replace(/\.?0+$/, '');
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

const recent: string[] = [];

export function log(tag: Tag, event: string, fields: Record<string, unknown> = {}): void {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(' ');
  const line = `[${tag}] ${event}${kv ? ' ' + kv : ''}`;
  recent.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  if (recent.length > 300) recent.shift();
  console.log(line);
}

/** Failures carry the status and the first 200 chars of the body. */
export function logFail(tag: Tag, event: string, err: unknown, fields: Record<string, unknown> = {}): void {
  log(tag, event, { ...fields, ok: false, ...describeError(err) });
}

export function describeError(err: unknown): { status?: number; body: string } {
  const e = err as { status?: number; statusCode?: number; message?: string; body?: unknown };
  const status = e?.status ?? e?.statusCode;
  const raw = e?.body !== undefined ? (typeof e.body === 'string' ? e.body : JSON.stringify(e.body)) : (e?.message ?? String(err));
  return { status, body: raw.replace(/\s+/g, ' ').slice(0, 200) };
}

export const recentLogs = () => recent.slice();

// ---- link status registry: one status per ID, reported by /health and the "status" voice command ----

const links = new Map<LinkId, LinkStatus>();
export const LINK_IDS: LinkId[] = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11'];

export function setLink(id: LinkId, state: LinkState, detail = ''): void {
  const prev = links.get(id);
  if (!prev || prev.state !== state) log(id, 'link', { state, detail: detail || undefined });
  links.set(id, { state, detail, at: Date.now() });
}

export const getLink = (id: LinkId): LinkStatus => links.get(id) ?? { state: 'unknown', detail: '', at: 0 };
export const allLinks = (): Record<LinkId, LinkStatus> =>
  Object.fromEntries(LINK_IDS.map((id) => [id, getLink(id)])) as Record<LinkId, LinkStatus>;
export const linkStates = (): Record<LinkId, LinkState> =>
  Object.fromEntries(LINK_IDS.map((id) => [id, getLink(id).state])) as Record<LinkId, LinkState>;

// ---- per-minute cost meter: frames/min and Gemini calls/min ----

const counters = { frames: 0, gemini: 0, geminiInTokens: 0, geminiOutTokens: 0, routes: 0, places: 0 };
export type Counter = keyof typeof counters;
export const count = (name: Counter, n = 1) => {
  counters[name] += n;
};

export function startCostMeter(): NodeJS.Timeout {
  const t = setInterval(() => {
    if (counters.frames || counters.gemini || counters.routes || counters.places) {
      log('cost', 'minute', {
        frames: counters.frames,
        gemini_calls: counters.gemini,
        gemini_tokens_in: counters.geminiInTokens,
        gemini_tokens_out: counters.geminiOutTokens,
        routes: counters.routes,
        places: counters.places,
      });
    }
    for (const k of Object.keys(counters) as Counter[]) counters[k] = 0;
  }, 60_000);
  t.unref();
  return t;
}
