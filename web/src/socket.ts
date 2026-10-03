// L2: one WebSocket to the server (/phone). Frames and fixes up; earcon cues and speech triggers down.

import type { FrameMsg, PhoneToServer, ServerToPhone } from '../../server/src/protocol.ts';

const APP_VERSION = '0.1.0';

export class PhoneSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private queuedFrame: FrameMsg | null = null;
  private drainTimer: number | null = null;
  framesSent = 0;
  framesReplaced = 0;

  constructor(
    private session: string,
    private record: boolean,
    private onMessage: (msg: ServerToPhone) => void,
    private onState: (open: boolean) => void,
  ) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    // Relative to the page, so it is wss:// through the tunnel and never mixed content.
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/phone`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      // The same session ID on every reconnect: nav state lives on the server, keyed by it.
      ws.send(JSON.stringify({ type: 'hello', session: this.session, replay: false, record: this.record, app: APP_VERSION } satisfies PhoneToServer));
      this.onState(true);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {
        // not JSON: ignore
      }
    };
    ws.onclose = () => {
      this.onState(false);
      if (this.closed) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: Exclude<PhoneToServer, FrameMsg>): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  /** One upload in flight; a newer frame replaces a queued one. */
  sendFrame(frame: FrameMsg): void {
    if (this.queuedFrame) this.framesReplaced++;
    this.queuedFrame = frame;
    this.drain();
  }

  private drain(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (!this.queuedFrame) return;
    if (this.open && this.ws!.bufferedAmount === 0) {
      this.ws!.send(JSON.stringify(this.queuedFrame));
      this.queuedFrame = null;
      this.framesSent++;
      return;
    }
    this.drainTimer = window.setTimeout(() => this.drain(), 50);
  }

  close(): void {
    this.closed = true;
    this.queuedFrame = null;
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.ws?.close();
  }
}
