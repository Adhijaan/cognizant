// ElevenLabs: ears and mouth only (design.md §10). The server writes every word.
// L4: the Speech Engine connects in over WSS on /ws. L8: REST for tokens and engine config.

import { ElevenLabsClient, type SpeechEngineCallbacks, type SpeechEngineSession } from '@elevenlabs/elevenlabs-js';
import type { Server } from 'node:http';
import { config, speechEngineWsUrl } from './config.ts';
import { log, logFail, setLink } from './log.ts';
import { NAV_TAG_RE } from './protocol.ts';
import { latestLiveSession, sessionByConversation, type Session } from './session.ts';

type TranscriptMessage = Parameters<NonNullable<SpeechEngineCallbacks['onTranscript']>>[0][number];

let client: ElevenLabsClient | null = null;
export function elevenlabs(): ElevenLabsClient {
  if (!config.elevenLabsApiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  client ??= new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });
  return client;
}

export const voiceConfigured = () => Boolean(config.elevenLabsApiKey && config.speechEngineId);

/** When the engine last sent `init` — the L4 health probe wants one since start. */
export let lastInitAt = 0;

/** L8: a conversation token for the phone. The engine ID stands in as agent_id. */
export async function conversationToken(): Promise<string> {
  if (!voiceConfigured()) throw new Error('ELEVENLABS_API_KEY and SPEECH_ENGINE_ID must be set (run `npm run engine:create`)');
  const started = Date.now();
  try {
    const res = await elevenlabs().conversationalAi.conversations.getWebrtcToken({ agentId: config.speechEngineId });
    log('L8', 'token', { ms: Date.now() - started });
    setLink('L8', 'ok');
    return res.token;
  } catch (err) {
    logFail('L8', 'token', err, { ms: Date.now() - started });
    setLink('L8', 'down', 'token request failed — wrong engine ID, or engine created under another key');
    throw err;
  }
}

export function attachSpeechEngine(httpServer: Server): void {
  if (!voiceConfigured()) {
    setLink('L4', 'off', config.elevenLabsApiKey ? 'SPEECH_ENGINE_ID not set — run `npm run engine:create`' : 'ELEVENLABS_API_KEY not set');
    return;
  }
  const bound = new WeakMap<SpeechEngineSession, Session>();

  // L3 and L4 are two halves of one conversation: pair them by conversation ID (`bind`),
  // falling back to the one live phone when the IDs haven't matched yet.
  const sessionFor = (speech: SpeechEngineSession): Session | null => {
    const byId = speech.conversationId ? sessionByConversation(speech.conversationId) : null;
    const session = byId ?? bound.get(speech) ?? latestLiveSession();
    if (session && bound.get(speech) !== session) {
      bound.set(speech, session);
      log('L4', 'paired', { conversation: speech.conversationId, session: session.id, by: byId ? 'bind' : 'latest_phone' });
    }
    return session;
  };

  elevenlabs().speechEngine.attach(config.speechEngineId, httpServer, '/ws', {
    debug: process.env.DEBUG_L4 === '1',

    onInit(conversationId, speech) {
      lastInitAt = Date.now();
      log('L4', 'init', { conversation: conversationId });
      setLink('L4', 'ok', 'init seen');
      sessionFor(speech);
    },

    async onTranscript(transcript: TranscriptMessage[], signal: AbortSignal, speech: SpeechEngineSession) {
      const last = [...transcript].reverse().find((m) => m.role === 'user');
      const text = last?.content?.trim() ?? '';
      const proactive = NAV_TAG_RE.test(text);
      log('L4', 'user_transcript', { conversation: speech.conversationId, proactive, text });
      if (!text) return;
      const session = sessionFor(speech);
      if (!session) {
        log('L4', 'no_session', { conversation: speech.conversationId });
        return void speech.sendResponse(proactive ? '' : "I've lost the connection to your phone's camera. Try starting again.");
      }
      const started = Date.now();
      // The signal aborts when the user interrupts: it is forwarded to Gemini so the in-flight call is dropped.
      const reply = await session.handleUserTurn(text, signal);
      if (signal.aborted || !speech.isOpen) return;
      await speech.sendResponse(reply);
      if (proactive) log('L4', 'proactive', { ms: Date.now() - started, text: reply });
    },

    onClose(speech) {
      log('L4', 'close', { conversation: speech.conversationId });
    },
    onDisconnect(speech) {
      log('L4', 'disconnect', { conversation: speech.conversationId });
    },
    onError(error, speech) {
      log('L4', 'error', { conversation: speech.conversationId, body: String(error.message ?? error).slice(0, 200) });
    },
  });

  setLink('L4', 'unknown', 'attached on /ws — waiting for the first init');
  log('L4', 'attached', { engine: config.speechEngineId, path: '/ws', expect_ws_url: speechEngineWsUrl() ?? 'PUBLIC_URL not set' });
}
