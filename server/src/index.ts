// One Node process on one port serves the app, /phone, /ws, /api/token, /health and /debug,
// so one tunnel covers everything that must be reachable from outside (design.md §15).

import express, { type Request } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, speechEngineWsUrl } from './config.ts';
import { lastResponses } from './google.ts';
import { bootId, health } from './health.ts';
import { allLinks, describeError, log, recentLogs, setLink, startCostMeter } from './log.ts';
import { attachPhoneSocket } from './phone.ts';
import { allSessions, startSessionTimer } from './session.ts';
import { attachSpeechEngine, conversationToken } from './voice.ts';

const app = express();
app.disable('x-powered-by');

const isLaptop = (req: Request) => /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'];

app.get('/ping', (_req, res) => {
  res.json({ ok: true, boot: bootId });
});

app.get('/health', async (req, res) => {
  res.json(await health(req.query.fresh !== undefined));
});

// L1 → L8: the phone gets a conversation token and nothing else. Keys stay here.
app.get('/api/token', async (_req, res) => {
  try {
    res.json({ token: await conversationToken() });
  } catch (err) {
    res.status(500).json({ error: { link: 'L8', message: describeError(err).body } });
  }
});

// Laptop only: link table, last gate decisions, last observation, current mode, last L6/L7 responses.
const debugState = () => ({
  links: allLinks(),
  config: {
    publicUrl: config.publicUrl || null,
    expectedWsUrl: speechEngineWsUrl(),
    speechEngineId: config.speechEngineId || null,
    models: { fast: config.geminiModelFast, main: config.geminiModel },
    cameraHfovDeg: config.cameraHfovDeg,
  },
  sessions: allSessions().map((s) => s.debug()),
  lastResponses,
  logs: recentLogs().slice(-80),
});

app.get('/debug.json', (req, res) => {
  if (!isLaptop(req)) return void res.status(403).json({ error: 'laptop only' });
  res.json(debugState());
});

app.get('/debug', (req, res) => {
  if (!isLaptop(req)) return void res.status(403).send('laptop only');
  const state = debugState();
  const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const links = Object.entries(state.links)
    .map(([id, l]) => `<tr class="${l.state}"><td>${id}</td><td>${l.state}</td><td>${esc(l.detail)}</td></tr>`)
    .join('');
  const sessions = state.sessions
    .map(
      (s) => `<h2>session ${esc(s.id)} — ${s.mode}${s.destination ? ` → ${esc(s.destination)}` : ''}${s.phoneConnected ? '' : ' (phone disconnected)'}</h2>
<h3>last 20 gate decisions</h3><pre>${esc(s.gateDecisions.map((d) => `${new Date(d.at).toISOString().slice(11, 19)} key=${d.key} action=${d.action}${d.reason ? ` reason=${d.reason}` : ''} p=${d.priority}${d.text ? ` "${d.text}"` : ''}`).join('\n') || '(none)')}</pre>
<h3>last observation</h3><pre>${esc(JSON.stringify(s.lastObservation, null, 2))}</pre>
<h3>state</h3><pre>${esc(JSON.stringify({ ...s, gateDecisions: undefined, lastObservation: undefined }, null, 2))}</pre>`,
    )
    .join('');
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>debug</title>
<style>body{font:13px ui-monospace,Menlo,monospace;margin:16px;background:#111;color:#ddd}td{padding:2px 12px 2px 0}
.ok td:nth-child(2){color:#6c6}.down td:nth-child(2){color:#f66}.off td:nth-child(2),.unknown td:nth-child(2){color:#cc6}
pre{background:#1b1b1b;padding:8px;overflow:auto}h2{margin-top:24px}h3{margin:12px 0 4px;color:#999}</style>
<h1>links</h1><table>${links}</table>
${sessions || '<p>no sessions yet</p>'}
<h2>last L6 / L7 responses</h2><pre>${esc(JSON.stringify(state.lastResponses, null, 2).slice(0, 6000))}</pre>
<h2>config</h2><pre>${esc(JSON.stringify(state.config, null, 2))}</pre>
<h2>log</h2><pre>${esc(state.logs.join('\n'))}</pre>`);
});

// L1: the phone app, built by `npm run build` in web/.
const indexHtml = path.join(config.webDist, 'index.html');
app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
app.get('/', (_req, res) => {
  if (!fs.existsSync(indexHtml)) return void res.status(503).type('text/plain').send('The phone app is not built yet. Run `npm run build` in web/ (or `npm run build` at the repo root).');
  res.set('Cache-Control', 'no-store').sendFile(indexHtml);
});

const server = http.createServer(app);
attachPhoneSocket(server); // L2 / L11 on /phone
attachSpeechEngine(server); // L4 on /ws

server.listen(config.port, () => {
  log('server', 'listening', { port: config.port, public_url: config.publicUrl || 'not set' });
  setLink('L1', fs.existsSync(indexHtml) ? 'ok' : 'down', fs.existsSync(indexHtml) ? '' : 'web/dist missing — run `npm run build`');
  for (const [name, value] of [
    ['GEMINI_API_KEY', config.geminiApiKey],
    ['GOOGLE_MAPS_API_KEY', config.googleMapsApiKey],
    ['ELEVENLABS_API_KEY', config.elevenLabsApiKey],
    ['SPEECH_ENGINE_ID', config.speechEngineId],
    ['PUBLIC_URL', config.publicUrl],
  ]) {
    if (!value) log('server', 'missing_env', { name });
  }
  startCostMeter();
  startSessionTimer();
  // Fill the link table once at start, so /debug and the "status" command have answers straight away.
  void health(true).catch(() => {});
});

server.on('error', (err) => {
  log('server', 'listen_error', { body: String(err).slice(0, 200) });
  process.exit(1);
});
