// L5: GET /v1beta/models — confirm GEMINI_MODEL_FAST and GEMINI_MODEL exist.
//   npm run models:list

import { config } from '../src/config.ts';
import { listModels } from '../src/gemini.ts';
import { describeError } from '../src/log.ts';
import { die } from './env-file.ts';

try {
  const models = await listModels();
  for (const m of models.filter((m) => /flash/i.test(m)).sort()) console.log(`  ${m}`);
  for (const [name, model] of [['GEMINI_MODEL_FAST', config.geminiModelFast], ['GEMINI_MODEL', config.geminiModel]]) {
    console.log(`[L5] ${name}=${model} ${models.includes(model) ? 'ok' : 'NOT FOUND — pick one from the list above'}`);
  }
} catch (err) {
  const { status, body } = describeError(err);
  die(`[L5] models list failed status=${status ?? '-'} body=${body}`);
}
