// L10 → L8: free-tier ngrok changes URL on restart. Read the current tunnel URL from ngrok's local API,
// save it as PUBLIC_URL, and point the Speech Engine's wsUrl at it — otherwise L4 silently never connects.
//   npm run tunnel:sync

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { config, speechEngineWsUrl } from '../src/config.ts';
import { describeError } from '../src/log.ts';
import { die, ngrokPublicUrl, upsertEnv } from './env-file.ts';

const publicUrl = await ngrokPublicUrl(config.port);
if (!publicUrl) die(`[L10] No ngrok tunnel to port ${config.port} found at http://127.0.0.1:4040. Start it: ngrok http ${config.port}`);

if (publicUrl !== config.publicUrl) {
  upsertEnv('PUBLIC_URL', publicUrl);
  console.log(`[L10] PUBLIC_URL ${config.publicUrl || '(unset)'} → ${publicUrl} (saved to .env)`);
} else {
  console.log(`[L10] PUBLIC_URL unchanged: ${publicUrl}`);
}

const wsUrl = speechEngineWsUrl(publicUrl)!;
if (!config.elevenLabsApiKey || !config.speechEngineId) {
  console.log('[L8] ELEVENLABS_API_KEY / SPEECH_ENGINE_ID not set — skipped the engine update. Run `npm run engine:create` next.');
  process.exit(0);
}
try {
  const elevenlabs = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });
  const before = await elevenlabs.speechEngine.get(config.speechEngineId);
  if (before.config?.speechEngine.wsUrl === wsUrl) {
    console.log(`[L8] engine wsUrl already ${wsUrl}`);
  } else {
    const engine = await elevenlabs.speechEngine.update(config.speechEngineId, { speechEngine: { wsUrl } });
    console.log(`[L8] engine wsUrl ${before.config?.speechEngine.wsUrl} → ${engine.config?.speechEngine.wsUrl}`);
  }
  console.log(`Open on the phone: ${publicUrl}`);
} catch (err) {
  const { status, body } = describeError(err);
  die(`[L8] engine update failed status=${status ?? '-'} body=${body}`);
}
