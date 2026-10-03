// L6 (Routes) and L7 (Places Text Search, New). The key stays on the server.

import { config } from './config.ts';
import { count, log, setLink } from './log.ts';
import { cleanInstruction } from './lines.ts';
import { buildRoute, type Destination, type RawStep, type Route } from './nav/core.ts';
import { decodePolyline, haversine, type LatLng } from './nav/geo.ts';

/** Last raw responses, shown on /debug: read these before blaming the step tracker. */
export const lastResponses: { L6?: unknown; L7?: unknown } = {};

async function post(link: 'L6' | 'L7', event: string, url: string, fieldMask: string, body: unknown): Promise<any> {
  if (!config.googleMapsApiKey) {
    setLink(link, 'off', 'GOOGLE_MAPS_API_KEY not set');
    throw new Error('GOOGLE_MAPS_API_KEY is not set');
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.googleMapsApiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    log(link, event, { ok: false, ms: Date.now() - started, body: String(err).slice(0, 200) });
    setLink(link, 'down', 'network error');
    throw err;
  }
  const text = await res.text();
  const ms = Date.now() - started;
  if (!res.ok) {
    log(link, event, { ok: false, ms, status: res.status, body: text.replace(/\s+/g, ' ').slice(0, 200) });
    setLink(link, 'down', res.status === 403 ? `403 — ${link === 'L6' ? 'Routes API' : 'Places API (New)'} not enabled or key restricted` : `HTTP ${res.status}`);
    throw Object.assign(new Error(`${link} ${res.status}`), { status: res.status, body: text });
  }
  const json = JSON.parse(text);
  lastResponses[link] = json;
  return Object.assign(json, { __ms: ms });
}

// ---- L7: Places ----

export interface PlaceCandidate {
  placeId: string;
  name: string;
  location: LatLng;
  /** meters from the campus center */
  fromCampus: number;
}

/** Candidates biased to Central Campus. Anything outside the campus radius is dropped: it's out of scope. */
export async function searchPlaces(textQuery: string): Promise<PlaceCandidate[]> {
  count('places');
  const json = await post('L7', 'places', 'https://places.googleapis.com/v1/places:searchText', 'places.id,places.displayName,places.location', {
    textQuery,
    maxResultCount: 5,
    locationBias: { circle: { center: { latitude: config.campus.lat, longitude: config.campus.lng }, radius: config.placesRadiusM } },
  });
  const all: PlaceCandidate[] = (json.places ?? [])
    .filter((p: any) => p.id && p.location)
    .map((p: any) => {
      const location = { lat: p.location.latitude, lng: p.location.longitude };
      return { placeId: p.id, name: p.displayName?.text ?? textQuery, location, fromCampus: haversine(location, config.campus) };
    });
  const onCampus = all.filter((p) => p.fromCampus <= config.placesRadiusM);
  log('L7', 'places', { ms: json.__ms, query: textQuery, results: all.length, on_campus: onCampus.length, top: onCampus[0]?.name });
  setLink('L7', 'ok');
  return onCampus;
}

// ---- L6: Routes ----

const ROUTE_FIELDS = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.endLocation',
].join(',');

/** Walking route from `origin` to the destination's entrance point. Never hands off to the Maps app. */
export async function computeWalkingRoute(origin: LatLng, destination: Destination): Promise<Route> {
  count('routes');
  const latLng = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const json = await post('L6', 'route', 'https://routes.googleapis.com/directions/v2:computeRoutes', ROUTE_FIELDS, {
    origin: latLng(origin),
    // The entrance point, not the place ID: building coordinates are rarely the door.
    destination: latLng(destination.entrance),
    travelMode: 'WALK',
    languageCode: 'en-US',
    units: 'IMPERIAL',
  });
  const route = json.routes?.[0];
  if (!route?.polyline?.encodedPolyline) {
    log('L6', 'route', { ok: false, ms: json.__ms, body: 'empty routes — bad destination?' });
    throw new Error('no route');
  }
  const points = decodePolyline(route.polyline.encodedPolyline);
  const steps: RawStep[] = (route.legs ?? []).flatMap((leg: any) =>
    (leg.steps ?? []).map((s: any) => ({
      instruction: cleanInstruction(s.navigationInstruction?.instructions ?? ''),
      maneuver: s.navigationInstruction?.maneuver ?? '',
      distanceMeters: s.distanceMeters ?? 0,
      end: { lat: s.endLocation?.latLng?.latitude, lng: s.endLocation?.latLng?.longitude },
    })),
  );
  const durationS = Number(String(route.duration ?? '0s').replace(/s$/, '')) || 0;
  log('L6', 'route', { ms: json.__ms, meters: route.distanceMeters, duration_s: durationS, steps: steps.length, points: points.length });
  setLink('L6', 'ok');
  return buildRoute(points, steps.filter((s) => Number.isFinite(s.end.lat) && Number.isFinite(s.end.lng)), durationS, destination);
}
