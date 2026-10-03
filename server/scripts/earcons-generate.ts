// Pre-generate the earcon clips in the ElevenLabs voice and bundle them with the app (design.md §5).
//   npm run earcons:generate

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../src/config.ts';
import { describeError } from '../src/log.ts';
import { EARCONS } from '../src/protocol.ts';
import { die } from './env-file.ts';

if (!config.elevenLabsApiKey) die('[L8] ELEVENLABS_API_KEY is not set in .env');
if (!config.voiceId) die('[L8] ELEVENLABS_VOICE_ID is not set in .env — use the same voice as the Speech Engine so the earcons match');

const elevenlabs = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });
const dirs = [path.join(ROOT_DIR, 'web', 'public', 'earcons'), path.join(config.webDist, 'earcons')].filter((d) => fs.existsSync(path.dirname(d)));

for (const [clip, text] of Object.entries(EARCONS)) {
  try {
    const stream = await elevenlabs.textToSpeech.convert(config.voiceId, { text, modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128' });
    const audio = Buffer.from(await new Response(stream).arrayBuffer());
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${clip}.mp3`), audio);
    }
    console.log(`[L8] earcon ${clip}.mp3 "${text}" ${Math.round(audio.length / 1024)} KB`);
  } catch (err) {
    const { status, body } = describeError(err);
    die(`[L8] earcon ${clip} failed status=${status ?? '-'} body=${body}`);
  }
}
console.log(`Saved to ${dirs.join(' and ')}. Until these exist the phone falls back to tones.`);
