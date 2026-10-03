import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, '..');
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');
export const ENV_PATH = path.join(ROOT_DIR, '.env');

dotenv.config({ path: ENV_PATH, quiet: true });

const str = (name: string, fallback = '') => (process.env[name] ?? fallback).trim();
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};

export const config = {
  port: num('PORT', 3000),
  publicUrl: str('PUBLIC_URL').replace(/\/+$/, ''),
  elevenLabsApiKey: str('ELEVENLABS_API_KEY'),
  speechEngineId: str('SPEECH_ENGINE_ID'),
  voiceId: str('ELEVENLABS_VOICE_ID'),
  geminiApiKey: str('GEMINI_API_KEY'),
  geminiModelFast: str('GEMINI_MODEL_FAST', 'gemini-flash-lite-latest'),
  geminiModel: str('GEMINI_MODEL', 'gemini-flash-latest'),
  googleMapsApiKey: str('GOOGLE_MAPS_API_KEY'),
  campus: { lat: num('CAMPUS_LAT', 42.277), lng: num('CAMPUS_LNG', -83.738) },
  placesRadiusM: num('PLACES_RADIUS_M', 1500),
  replayDir: path.resolve(ROOT_DIR, str('REPLAY_DIR', 'recordings')),
  cameraHfovDeg: num('CAMERA_HFOV_DEG', 50),
  sessionGeminiCap: num('SESSION_GEMINI_CAP', 1500),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  entrancesPath: path.join(SERVER_DIR, 'data', 'entrances.json'),
};

/** wss://<PUBLIC_URL host>/ws — what the Speech Engine's wsUrl must equal (L4). */
export function speechEngineWsUrl(publicUrl = config.publicUrl): string | null {
  if (!publicUrl) return null;
  try {
    return `wss://${new URL(publicUrl).host}/ws`;
  } catch {
    return null;
  }
}

/** `npm run tunnel:sync` rewrites PUBLIC_URL in .env while the server is running: pick the new value up. */
export function refreshPublicUrl(): void {
  try {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH));
    if (parsed.PUBLIC_URL) config.publicUrl = parsed.PUBLIC_URL.trim().replace(/\/+$/, '');
  } catch {
    // no .env: keep what the environment gave us
  }
}
