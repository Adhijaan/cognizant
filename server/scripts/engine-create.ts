// L8: create the Speech Engine (or update it, if SPEECH_ENGINE_ID is already set) and save its ID to .env.
//   npm run engine:create

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { config, speechEngineWsUrl } from '../src/config.ts';
import { describeError } from '../src/log.ts';
import { die, ngrokPublicUrl, upsertEnv } from './env-file.ts';

if (!config.elevenLabsApiKey) die('[L8] ELEVENLABS_API_KEY is not set in .env');

const publicUrl = config.publicUrl || (await ngrokPublicUrl(config.port));
const wsUrl = speechEngineWsUrl(publicUrl ?? '');
if (!publicUrl || !wsUrl) die(`[L10] No PUBLIC_URL in .env and no ngrok tunnel to port ${config.port} found. Start the tunnel first: ngrok http ${config.port}`);
if (!config.publicUrl) upsertEnv('PUBLIC_URL', publicUrl);

const elevenlabs = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });
const request = {
  name: 'Campus spatial awareness assistant',
  speechEngine: { wsUrl },
  language: 'en',
  // Lets the phone set the first message ("Ready…") at session start.
  overrides: { firstMessage: true },
  ...(config.voiceId ? { tts: { voiceId: config.voiceId } } : {}),
};

try {
  if (config.speechEngineId) {
    const engine = await elevenlabs.speechEngine.update(config.speechEngineId, request);
    console.log(`[L8] engine updated id=${engine.engineId} wsUrl=${engine.config?.speechEngine.wsUrl}`);
  } else {
    const engine = await elevenlabs.speechEngine.create(request);
    upsertEnv('SPEECH_ENGINE_ID', engine.engineId);
    console.log(`[L8] engine created id=${engine.engineId} wsUrl=${engine.config?.speechEngine.wsUrl}`);
    console.log('[L8] SPEECH_ENGINE_ID saved to .env — restart the server so it attaches on /ws.');
  }
  if (!config.voiceId) console.log('[L8] ELEVENLABS_VOICE_ID is not set: the engine uses its default voice. Set it and re-run to change the voice.');
} catch (err) {
  const { status, body } = describeError(err);
  die(`[L8] engine create/update failed status=${status ?? '-'} body=${body}`);
}
