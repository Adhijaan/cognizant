// L5: server → Gemini. Plain generateContent with a response schema — never free prose (design.md §9).

import { GoogleGenAI, type Part } from '@google/genai';
import { config } from './config.ts';
import { count, describeError, log, setLink } from './log.ts';

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

export const geminiConfigured = () => Boolean(config.geminiApiKey);

// Thinking must be off (fast model) or minimal (main model). Which knob a model accepts depends on its
// generation — thinkingBudget on 2.5, thinkingLevel on 3+ — so try the preferred one and remember what worked.
type Thinking = { thinkingBudget: number } | { thinkingLevel: string } | undefined;
const THINKING_CHOICES: Record<'fast' | 'main', Thinking[]> = {
  fast: [{ thinkingBudget: 0 }, { thinkingLevel: 'MINIMAL' }, undefined],
  main: [{ thinkingLevel: 'MINIMAL' }, { thinkingBudget: 0 }, { thinkingBudget: 512 }, undefined],
};
const thinkingChoice = new Map<string, number>();

export interface JsonCall {
  /** Log event name, e.g. "obstacle". */
  name: string;
  tier: 'fast' | 'main';
  parts: Part[];
  schema: unknown;
  system?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface JsonResult<T> {
  data: T;
  ms: number;
  tokensIn: number;
  tokensOut: number;
}

export async function generateJson<T>(call: JsonCall): Promise<JsonResult<T>> {
  if (!config.geminiApiKey) {
    setLink('L5', 'off', 'GEMINI_API_KEY not set');
    throw new Error('GEMINI_API_KEY is not set');
  }
  const model = call.tier === 'fast' ? config.geminiModelFast : config.geminiModel;
  const choices = THINKING_CHOICES[call.tier];
  const started = Date.now();
  const timeout = AbortSignal.timeout(call.timeoutMs ?? 6000);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

  for (;;) {
    const choice = thinkingChoice.get(model) ?? 0;
    const thinkingConfig = choices[choice];
    try {
      count('gemini');
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: 'user', parts: call.parts }],
        config: {
          systemInstruction: call.system,
          responseMimeType: 'application/json',
          responseJsonSchema: call.schema,
          temperature: 0.2,
          maxOutputTokens: call.maxOutputTokens,
          abortSignal: signal,
          ...(thinkingConfig ? { thinkingConfig: thinkingConfig as never } : {}),
        },
      });
      const ms = Date.now() - started;
      const tokensIn = res.usageMetadata?.promptTokenCount ?? 0;
      const tokensOut = (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0);
      count('geminiInTokens', tokensIn);
      count('geminiOutTokens', tokensOut);
      const text = res.text;
      if (!text) throw new Error(`empty response (finishReason=${res.candidates?.[0]?.finishReason ?? 'none'})`);
      setLink('L5', 'ok', model);
      return { data: JSON.parse(text) as T, ms, tokensIn, tokensOut };
    } catch (err) {
      const { status, body } = describeError(err);
      // A 400 that names thinking means this model wants the other knob: move on and retry once per choice.
      if (status === 400 && /thinking/i.test(body) && choice < choices.length - 1) {
        thinkingChoice.set(model, choice + 1);
        log('L5', 'thinking_fallback', { model, tried: JSON.stringify(thinkingConfig ?? null) });
        continue;
      }
      if (call.signal?.aborted) throw err; // the user interrupted: not a link failure
      const ms = Date.now() - started;
      log('L5', call.name, { ok: false, model, ms, status, body });
      if (status === 404) setLink('L5', 'down', `model ${model} not found — run npm run models:list`);
      else if (status === 429) setLink('L5', 'down', 'rate limited — lower the frame cadence');
      else setLink('L5', 'down', body.slice(0, 80));
      throw err;
    }
  }
}

export const jpegPart = (base64: string): Part => ({ inlineData: { mimeType: 'image/jpeg', data: base64 } });

/** GET /v1beta/models — for the L5 health probe and `npm run models:list`. */
export async function listModels(): Promise<string[]> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
  const names: string[] = [];
  let pageToken = '';
  do {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': config.geminiApiKey }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
    const json = (await res.json()) as { models?: { name: string }[]; nextPageToken?: string };
    for (const m of json.models ?? []) names.push(m.name.replace(/^models\//, ''));
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return names;
}
