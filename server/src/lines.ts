// How lines are worded (design.md §10): short, landmark first, clock positions for objects,
// left/right for turns, feet rounded to 50, steps when close. Internal math stays in meters.

import type { EarconClip } from './protocol.ts';

const M_TO_FT = 3.28084;
const FT_PER_STEP = 2.5;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** "about 150 feet", or "about 12 steps" when close. */
export function spokenDistance(meters: number): string {
  const feet = meters * M_TO_FT;
  if (feet < 40) {
    const steps = Math.max(2, Math.round(feet / FT_PER_STEP / 2) * 2);
    return steps <= 4 ? 'a few steps' : `about ${steps} steps`;
  }
  const rounded = Math.max(50, Math.round(feet / 50) * 50);
  return `about ${rounded} feet`;
}

export function spokenMinutes(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  return min === 1 ? 'about one minute' : `about ${numberWord(min)} minutes`;
}

/** Angle in degrees, 0 = straight ahead, positive = right. */
export function clockPosition(angleDeg: number): string {
  if (Math.abs(angleDeg) < 8) return 'straight ahead';
  if (Math.abs(angleDeg) < 15) return angleDeg > 0 ? 'slightly to your right' : 'slightly to your left';
  let hour = Math.round(angleDeg / 30);
  if (hour === 0) hour = angleDeg > 0 ? 1 : -1;
  hour = ((hour % 12) + 12) % 12;
  if (hour === 0) return 'straight ahead';
  if (hour === 6) return 'behind you';
  return `at your ${numberWord(hour)} o'clock`;
}

const ABBREV: [RegExp, string][] = [
  [/\bSt\b\.?/g, 'Street'],
  [/\bAve\b\.?/g, 'Avenue'],
  [/\bBlvd\b\.?/g, 'Boulevard'],
  [/\bDr\b\.?/g, 'Drive'],
  [/\bRd\b\.?/g, 'Road'],
  [/\bPl\b\.?/g, 'Place'],
  [/\bCt\b\.?/g, 'Court'],
  [/\bLn\b\.?/g, 'Lane'],
  [/\bN\b\.?(?= [A-Z])/g, 'North'],
  [/\bS\b\.?(?= [A-Z])/g, 'South'],
  [/\bE\b\.?(?= [A-Z])/g, 'East'],
  [/\bW\b\.?(?= [A-Z])/g, 'West'],
];

/** "S State St" → "South State Street", so the voice doesn't read "S" and "Saint". */
export function expandAbbreviations(text: string): string {
  return ABBREV.reduce((t, [re, word]) => t.replace(re, word), text);
}

/** First line of a Google instruction, HTML stripped, abbreviations expanded, no trailing period. */
export function cleanInstruction(raw: string): string {
  const first = raw.split('\n')[0].replace(/<[^>]+>/g, '').trim();
  return expandAbbreviations(first).replace(/\.$/, '');
}

export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
export const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const sentence = (s: string) => {
  const t = upperFirst(s.trim());
  return /[.?!]$/.test(t) ? t : `${t}.`;
};

// ---- obstacles ----

export type ObstacleType =
  | 'bike'
  | 'scooter'
  | 'pole'
  | 'bench'
  | 'stairs'
  | 'curb'
  | 'construction'
  | 'closed_path'
  | 'vehicle'
  | 'person_stopped'
  | 'other';
export type Position = 'left' | 'center' | 'right';

const OBSTACLE_LABEL: Record<ObstacleType, string> = {
  bike: 'Bike',
  scooter: 'Scooter',
  pole: 'Pole',
  bench: 'Bench',
  stairs: 'Stairs',
  curb: 'Curb',
  construction: 'Construction fencing',
  closed_path: 'Path closed',
  vehicle: 'Vehicle',
  person_stopped: 'Person standing',
  other: 'Obstacle',
};

const SIDE: Record<Position, string> = { left: ', on your left', center: '', right: ', on your right' };

/** "Bike ahead, on your left." */
export function obstacleLine(type: ObstacleType, position: Position): string {
  return `${OBSTACLE_LABEL[type] ?? 'Obstacle'} ahead${SIDE[position] ?? ''}.`;
}

/** The pre-generated clip for a near, in-path obstacle. */
export function earconFor(type: ObstacleType, position: Position): EarconClip {
  if (type === 'stairs') return 'stairs_ahead';
  if ((type === 'closed_path' || type === 'construction') && position === 'center') return 'stop';
  return position === 'left' ? 'obstacle_left' : position === 'right' ? 'obstacle_right' : 'obstacle_ahead';
}

/** After the earcon, say what it was — unless the earcon already said it. */
export function obstacleDetail(type: ObstacleType): string | null {
  if (type === 'stairs' || type === 'other') return null;
  return `${OBSTACLE_LABEL[type]}.`;
}
