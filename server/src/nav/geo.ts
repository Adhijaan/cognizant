export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing a → b, degrees clockwise from north, 0–360. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest difference b − a, in (−180, 180]. Positive = b is clockwise (to the right) of a. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Google encoded polyline, precision 5. */
export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    enc(lat - pLat);
    enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

/** Cumulative distance along the line at each vertex. */
export function cumulative(line: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]));
  return cum;
}

export interface Snap {
  /** distance along the line to the snapped point, meters */
  along: number;
  /** distance from the fix to the line, meters */
  dist: number;
  /** index of the segment's first vertex */
  seg: number;
  point: LatLng;
}

/**
 * Nearest point on the polyline. With `window`, only segments overlapping [from, to] meters along the
 * line are considered, so a route that doubles back doesn't make the snapped point jump.
 */
export function snapToPolyline(p: LatLng, line: LatLng[], cum: number[], window?: { from: number; to: number }): Snap | null {
  if (line.length === 0) return null;
  if (line.length === 1) return { along: 0, dist: haversine(p, line[0]), seg: 0, point: line[0] };
  // Local flat projection around the fix: fine at campus scale.
  const mLat = (Math.PI * R) / 180;
  const mLng = mLat * Math.cos(rad(p.lat));
  let best: Snap | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    if (window && (cum[i + 1] < window.from || cum[i] > window.to)) continue;
    const ax = (line[i].lng - p.lng) * mLng;
    const ay = (line[i].lat - p.lat) * mLat;
    const bx = (line[i + 1].lng - p.lng) * mLng;
    const by = (line[i + 1].lat - p.lat) * mLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const dist = Math.hypot(cx, cy);
    if (!best || dist < best.dist) {
      best = {
        along: cum[i] + t * (cum[i + 1] - cum[i]),
        dist,
        seg: i,
        point: { lat: p.lat + cy / mLat, lng: p.lng + cx / mLng },
      };
    }
  }
  return best;
}

/** Bearing of the line a little ahead of `along` — the direction of travel there. */
export function bearingAlong(line: LatLng[], cum: number[], along: number, lookahead = 15): number | null {
  if (line.length < 2) return null;
  const at = (d: number): LatLng => {
    const target = Math.max(0, Math.min(cum[cum.length - 1], d));
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < target) i++;
    const span = cum[i + 1] - cum[i];
    const t = span === 0 ? 0 : (target - cum[i]) / span;
    return { lat: line[i].lat + t * (line[i + 1].lat - line[i].lat), lng: line[i].lng + t * (line[i + 1].lng - line[i].lng) };
  };
  const a = at(along);
  const b = at(along + lookahead);
  if (haversine(a, b) < 0.5) return null;
  return bearing(a, b);
}
