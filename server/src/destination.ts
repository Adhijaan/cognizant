// Destination resolution (design.md §7): nickname table → Places candidates → Gemini picks from
// the candidates (never invents a place) → hand-marked entrance if there is one.

import fs from 'node:fs';
import { config } from './config.ts';
import { generateJson, geminiConfigured } from './gemini.ts';
import { searchPlaces, type PlaceCandidate } from './google.ts';
import { log } from './log.ts';
import type { Destination } from './nav/core.ts';
import type { LatLng } from './nav/geo.ts';

interface Nickname {
  /** what to search Places for */
  query: string;
  /** what to call it out loud */
  spoken: string;
  aliases: string[];
}

const NICKNAMES: Nickname[] = [
  { query: 'Shapiro Undergraduate Library', spoken: 'the Shapiro Library', aliases: ['ugli', 'ugly', 'the ugli', 'undergrad library', 'shapiro', 'shapiro library'] },
  { query: 'Hatcher Graduate Library', spoken: 'the Hatcher Graduate Library', aliases: ['grad', 'the grad', 'grad library', 'graduate library', 'hatcher', 'hatcher library'] },
  { query: 'Michigan Union', spoken: 'the Michigan Union', aliases: ['union', 'the union'] },
  { query: 'Michigan League', spoken: 'the Michigan League', aliases: ['league', 'the league'] },
  { query: 'Angell Hall', spoken: 'Angell Hall', aliases: ['fishbowl', 'the fishbowl', 'fish bowl', 'angell', 'angel hall'] },
];

const NORTH_CAMPUS = ['dude', 'the dude', 'duderstadt', 'bbb', 'beyster', 'pierpont', 'north campus', 'bursley', 'eecs', 'walgreen', 'gg brown', 'fxb', 'lurie'];

const AMBIGUOUS: Record<string, string> = {
  library: 'Which library: the Shapiro Library, or the Hatcher Graduate Library?',
};

export const OUT_OF_SCOPE_LINE = "That's outside what I can do. I can walk you to buildings on Central Campus.";

export type Resolution =
  | { kind: 'ok'; destination: Destination; spokenName: string; note?: string }
  | { kind: 'ambiguous'; question: string }
  | { kind: 'out_of_scope'; line: string }
  | { kind: 'not_found'; line: string };

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|to|a|an|please|building)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Exact alias first, then a close misspelling/mishearing ("the uglee"). */
export function matchNickname(text: string): Nickname | null {
  const q = normalize(text);
  if (!q) return null;
  for (const n of NICKNAMES) if (n.aliases.some((a) => normalize(a) === q) || normalize(n.query) === q) return n;
  let best: { n: Nickname; d: number } | null = null;
  for (const n of NICKNAMES) {
    for (const alias of [...n.aliases, n.query]) {
      const a = normalize(alias);
      if (a.length < 4) continue;
      const d = editDistance(q, a);
      if (d <= (a.length >= 8 ? 2 : 1) && (!best || d < best.d)) best = { n, d };
    }
  }
  return best?.n ?? null;
}

export const isNorthCampus = (text: string) => {
  const q = ` ${normalize(text)} `;
  return NORTH_CAMPUS.some((n) => q.includes(` ${n} `));
};

/** "Angell Hall room 2225" → the building, plus a note that the route ends at the entrance. */
export function stripRoom(text: string): { text: string; hadRoom: boolean } {
  const stripped = text.replace(/\b(room|rm\.?|classroom|suite|office)\s*#?\s*[a-z]?\d+[a-z]?\b/gi, ' ').replace(/\b[a-z]?\d{3,4}[a-z]?\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { text: stripped || text, hadRoom: stripped !== text.replace(/\s+/g, ' ').trim() };
}

interface Entrance extends LatLng {
  label?: string;
  disabled?: boolean;
}

export function loadEntrances(): Record<string, Entrance> {
  try {
    const json = JSON.parse(fs.readFileSync(config.entrancesPath, 'utf8'));
    return Object.fromEntries(Object.entries((json.entrances ?? {}) as Record<string, Entrance>).filter(([, e]) => !e.disabled));
  } catch {
    return {};
  }
}

function handMarked(name: string): Entrance | null {
  const n = normalize(name);
  for (const [key, e] of Object.entries(loadEntrances())) {
    const k = normalize(key);
    if (k && (n.includes(k) || k.includes(n))) return e;
  }
  return null;
}

const PICK_SCHEMA = {
  type: 'object',
  properties: { index: { type: 'integer' }, confident: { type: 'boolean' } },
  required: ['index', 'confident'],
};

/** Gemini picks from the candidates by index. It can say "none" (−1) but cannot name a place of its own. */
async function pick(query: string, candidates: PlaceCandidate[], signal?: AbortSignal): Promise<{ index: number; confident: boolean }> {
  const q = normalize(query);
  const exact = candidates.findIndex((c) => normalize(c.name) === q);
  if (exact >= 0) return { index: exact, confident: true };
  if (candidates.length === 1 || !geminiConfigured()) return { index: 0, confident: candidates.length === 1 };
  try {
    const { data } = await generateJson<{ index: number; confident: boolean }>({
      name: 'pick_place',
      tier: 'main',
      system:
        'A student on the University of Michigan Central Campus asked to walk to a place. Choose which candidate they most likely mean. Answer with its index, or -1 if none fits. Set confident to false if two candidates fit about equally well.',
      parts: [{ text: JSON.stringify({ asked_for: query, candidates: candidates.map((c, i) => ({ index: i, name: c.name })) }) }],
      schema: PICK_SCHEMA,
      signal,
      maxOutputTokens: 50,
    });
    return { index: Number.isInteger(data.index) ? data.index : -1, confident: Boolean(data.confident) };
  } catch {
    return { index: 0, confident: true };
  }
}

export async function resolveDestination(destinationText: string, signal?: AbortSignal): Promise<Resolution> {
  if (isNorthCampus(destinationText)) return { kind: 'out_of_scope', line: "That's on North Campus, which I can't route to. I can walk you to buildings on Central Campus." };

  const { text, hadRoom } = stripRoom(destinationText);
  const note = hadRoom ? "I'll take you to the entrance, not the room." : undefined;
  const ambiguous = AMBIGUOUS[normalize(text)];
  if (ambiguous) return { kind: 'ambiguous', question: ambiguous };

  const nickname = matchNickname(text);
  const query = nickname?.query ?? text;
  const candidates = await searchPlaces(`${query}, University of Michigan, Ann Arbor`);
  if (candidates.length === 0) return { kind: 'out_of_scope', line: `I couldn't find ${text} on Central Campus. I can walk you to buildings on Central Campus.` };

  const choice = nickname ? { index: 0, confident: true } : await pick(text, candidates, signal);
  log('L7', 'pick', { query, index: choice.index, confident: choice.confident, name: candidates[choice.index]?.name });
  if (choice.index < 0 || choice.index >= candidates.length) return { kind: 'not_found', line: `I couldn't find ${text} on Central Campus. What's the building called?` };
  if (!choice.confident && candidates.length > 1) {
    const other = candidates.find((_, i) => i !== choice.index)!;
    return { kind: 'ambiguous', question: `Did you mean ${candidates[choice.index].name}, or ${other.name}?` };
  }

  const place = candidates[choice.index];
  const entrance = handMarked(place.name) ?? (nickname ? handMarked(nickname.query) : null);
  const spokenName = nickname?.spoken ?? place.name;
  return {
    kind: 'ok',
    spokenName,
    note,
    destination: {
      name: spokenName,
      placeId: place.placeId,
      entrance: entrance ? { lat: entrance.lat, lng: entrance.lng } : place.location,
      handMarked: Boolean(entrance),
    },
  };
}
