// /health probes, one per link, cached 60 s (design.md §15).

import fs from 'node:fs';
import path from 'node:path';
import { config, refreshPublicUrl, speechEngineWsUrl } from './config.ts';
import { listModels } from './gemini.ts';
import { allLinks, describeError, getLink, setLink } from './log.ts';
import type { LinkState } from './protocol.ts';
import { connectedSessions } from './session.ts';
import { elevenlabs, lastInitAt, voiceConfigured } from './voice.ts';

const CACHE_MS = 60_000;
let lastRun = 0;
let running: Promise<void> | null = null;
export const bootId = Math.random().toString(36).slice(2, 10);

async function probe(fn: () => Promise<[LinkState, string]>): Promise<[LinkState, string]> {
  try {
    return await fn();
  } catch (err) {
    const { status, body } = describeError(err);
    return ['down', `${status ? `HTTP ${status}: ` : ''}${body}`.slice(0, 160)];
  }
}

const mapsHeaders = (fieldMask: string) => ({ 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.googleMapsApiKey, 'X-Goog-FieldMask': fieldMask });
const diag = { location: { latLng: { latitude: config.campus.lat, longitude: config.campus.lng } } };

async function runProbes(): Promise<void> {
  const timeout = () => AbortSignal.timeout(8000);
  refreshPublicUrl();

  const results = await Promise.all([
    // L1: the app bundle is there to serve.
    probe(async () => (fs.existsSync(path.join(config.webDist, 'index.html')) ? ['ok', ''] : ['down', 'web/dist missing — run `npm run build`'])),

    // L5: both models are listed.
    probe(async () => {
      if (!config.geminiApiKey) return ['off', 'GEMINI_API_KEY not set'];
      const models = await listModels();
      const missing = [config.geminiModelFast, config.geminiModel].filter((m) => !models.includes(m));
      return missing.length ? ['down', `not in /v1beta/models: ${missing.join(', ')} — run \`npm run models:list\``] : ['ok', `${config.geminiModelFast}, ${config.geminiModel}`];
    }),

    // L6: a fixed Diag → Diag route returns steps.
    probe(async () => {
      if (!config.googleMapsApiKey) return ['off', 'GOOGLE_MAPS_API_KEY not set'];
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: mapsHeaders('routes.legs.steps.distanceMeters'),
        body: JSON.stringify({
          origin: diag,
          destination: { location: { latLng: { latitude: config.campus.lat + 0.0015, longitude: config.campus.lng + 0.001 } } },
          travelMode: 'WALK',
        }),
        signal: timeout(),
      });
      if (!res.ok) return ['down', `HTTP ${res.status}${res.status === 403 ? ' — Routes API not enabled or key restricted' : ''}`];
      const json = (await res.json()) as any;
      return json.routes?.[0]?.legs?.[0]?.steps?.length ? ['ok', ''] : ['down', 'no steps in the probe route'];
    }),

    // L7: "Angell Hall" returns a campus place ID.
    probe(async () => {
      if (!config.googleMapsApiKey) return ['off', 'GOOGLE_MAPS_API_KEY not set'];
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: mapsHeaders('places.id,places.displayName'),
        body: JSON.stringify({ textQuery: 'Angell Hall', locationBias: { circle: { center: diag.location.latLng, radius: config.placesRadiusM } } }),
        signal: timeout(),
      });
      if (!res.ok) return ['down', `HTTP ${res.status}${res.status === 403 ? ' — Places API (New) not enabled or key restricted' : ''}`];
      const json = (await res.json()) as any;
      return json.places?.[0]?.id ? ['ok', json.places[0].displayName?.text ?? ''] : ['down', 'no place returned for "Angell Hall"'];
    }),

    // L8: GET /v1/user is 200.
    probe(async () => {
      if (!config.elevenLabsApiKey) return ['off', 'ELEVENLABS_API_KEY not set'];
      const res = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': config.elevenLabsApiKey }, signal: timeout() });
      return res.ok ? ['ok', ''] : ['down', `HTTP ${res.status}${res.status === 401 ? ' — bad API key' : ''}`];
    }),

    // L4: the engine's wsUrl matches PUBLIC_URL, and an init has been seen since start.
    probe(async () => {
      if (!voiceConfigured()) return ['off', getLink('L4').detail || 'not configured'];
      const expected = speechEngineWsUrl();
      if (!expected) return ['down', 'PUBLIC_URL not set — run `npm run tunnel:sync`'];
      const engine = await elevenlabs().speechEngine.get(config.speechEngineId);
      const actual = engine.config?.speechEngine.wsUrl;
      if (actual !== expected) return ['down', `stale wsUrl: engine has ${actual}, expected ${expected} — run \`npm run tunnel:sync\``];
      return lastInitAt ? ['ok', 'wsUrl matches, init seen'] : ['unknown', 'wsUrl matches; no init since start'];
    }),

    // L10: ngrok's local API lists a tunnel to our port matching PUBLIC_URL; otherwise, reach ourselves through PUBLIC_URL.
    probe(async () => {
      if (!config.publicUrl) return ['off', 'PUBLIC_URL not set'];
      try {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(1500) });
        const json = (await res.json()) as { tunnels?: { public_url: string; config?: { addr?: string } }[] };
        const ours = (json.tunnels ?? []).filter((t) => String(t.config?.addr ?? '').endsWith(`:${config.port}`));
        if (ours.some((t) => t.public_url === config.publicUrl)) return ['ok', config.publicUrl];
        if (ours.length) return ['down', `tunnel URL changed to ${ours[0].public_url} — run \`npm run tunnel:sync\``];
        return ['down', `ngrok is running but has no tunnel to port ${config.port}`];
      } catch {
        // No ngrok API (cloudflared, reserved domain elsewhere): go out and come back in.
        const res = await fetch(`${config.publicUrl}/ping`, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: timeout() });
        const json = (await res.json().catch(() => null)) as { boot?: string } | null;
        if (json?.boot === bootId) return ['ok', config.publicUrl];
        return ['down', res.ok ? 'PUBLIC_URL answers, but not from this server' : `HTTP ${res.status} through the tunnel`];
      }
    }),
  ]);

  (['L1', 'L5', 'L6', 'L7', 'L8', 'L4', 'L10'] as const).forEach((id, i) => setLink(id, results[i][0], results[i][1]));
}

export async function health(fresh = false) {
  if (fresh || Date.now() - lastRun > CACHE_MS) {
    running ??= runProbes().finally(() => {
      lastRun = Date.now();
      running = null;
    });
    await running;
  }
  // L2 is reported, not judged.
  const phones = connectedSessions();
  const links = allLinks();
  const ok = Object.entries(links).every(([, s]) => s.state !== 'down');
  return {
    ok,
    checkedAt: new Date(lastRun).toISOString(),
    phones: phones.map((s) => ({ session: s.id, replay: s.replay, mode: s.mode, frames: s.frames, fixes: s.fixes })),
    links: Object.fromEntries(Object.entries(links).map(([id, s]) => [id, { state: s.state, detail: s.detail }])),
  };
}
