// L2: phone ↔ server over /phone (and L11: the replay client uses the same path).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { log, setLink } from './log.ts';
import type { ErrorMsg, LinkId, PhoneToServer } from './protocol.ts';
import { connectedSessions, getOrCreateSession, type Session } from './session.ts';
import { voiceConfigured } from './voice.ts';

const isLoopback = (req: IncomingMessage) => {
  const addr = req.socket.remoteAddress ?? '';
  // The tunnel also arrives from loopback; it adds a forwarding header.
  return /^(::1|::ffff:127\.|127\.)/.test(addr) && !req.headers['x-forwarded-for'];
};

export function attachPhoneSocket(httpServer: Server): WebSocketServer {
  // noServer + our own upgrade routing: the Speech Engine listens for upgrades on /ws on this same server.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/phone') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    // /ws belongs to the Speech Engine attachment (L4). If it isn't attached, nobody would answer: refuse.
    if (pathname !== '/ws' || !voiceConfigured()) socket.destroy();
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let session: Session | null = null;
    const local = isLoopback(req);
    const fail = (link: LinkId, message: string) => ws.send(JSON.stringify({ type: 'error', link, message } satisfies ErrorMsg));

    // The first message must be `hello`.
    const helloTimer = setTimeout(() => {
      if (!session) {
        fail('L2', 'no hello within 5 s');
        ws.close(4001, 'hello expected');
      }
    }, 5000);

    ws.on('message', (data) => {
      let msg: PhoneToServer;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return fail('L2', 'message is not JSON');
      }

      if (!session) {
        if (msg.type !== 'hello' || typeof msg.session !== 'string' || !msg.session) {
          fail('L2', 'first message must be {"type":"hello","session":"..."}');
          return ws.close(4001, 'hello expected');
        }
        clearTimeout(helloTimer);
        // Replay sessions feed recorded data into the real pipeline: laptop only.
        if (msg.replay && !local) {
          fail('L11', 'replay sessions are only accepted from localhost');
          return ws.close(4003, 'replay is local only');
        }
        session = getOrCreateSession(msg.session, { replay: msg.replay, record: msg.record });
        const resumed = session.frames > 0 || session.fixes > 0;
        session.attachPhone(ws);
        log(session.tag, 'hello', { session: session.id, app: msg.app, replay: session.replay, resumed, mode: session.mode });
        setLink(session.tag, 'ok', `${connectedSessions().length} connected`);
        return session.sendSession();
      }

      switch (msg.type) {
        case 'frame':
          if (typeof msg.jpeg !== 'string' || !msg.jpeg) return fail('L2', 'frame without jpeg');
          return session.handleFrame(msg);
        case 'fix':
          return session.handleFix(msg);
        case 'status':
          return session.handleStatus(msg);
        case 'voice':
          return session.handleVoice(msg);
        case 'bind':
          session.conversationId = msg.conversationId;
          return log('L2', 'bind', { session: session.id, conversation: msg.conversationId });
        case 'say': {
          // A typed user turn, for replay and desk debugging. Live turns must come from the user's voice over L4.
          if (!session.replay && !local) return fail('L2', '`say` is only accepted from replay or localhost');
          const s = session;
          return void s
            .handleUserTurn(String(msg.text ?? ''))
            .then((text) => s.send({ type: 'speak', key: 'reply', text }))
            .catch((err) => fail('L5', String(err).slice(0, 200)));
        }
        case 'hello':
          return session.sendSession();
        default:
          return fail('L2', `unknown message type ${(msg as { type?: string }).type}`);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(helloTimer);
      if (!session) return;
      session.detachPhone(ws);
      log(session.tag, 'close', { session: session.id, code });
      const n = connectedSessions().filter((s) => s.replay === session!.replay).length;
      setLink(session.tag, n ? 'ok' : 'unknown', n ? `${n} connected` : 'no phone connected');
    });
    ws.on('error', (err) => log(session?.tag ?? 'L2', 'socket_error', { body: String(err).slice(0, 200) }));
  });

  return wss;
}
