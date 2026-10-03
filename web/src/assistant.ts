// The phone side of the assistant: camera bursts, GPS, compass up; earcons and speech triggers down.
// It decides nothing — the server is the only brain (design.md §3).

import { Conversation } from '@elevenlabs/react';
import type { ServerToPhone } from '../../server/src/protocol.ts';
import { Camera } from './capture.ts';
import { Earcons } from './earcons.ts';
import { Sensors } from './sensors.ts';
import { PhoneSocket } from './socket.ts';

type VoiceSession = Awaited<ReturnType<typeof Conversation.startSession>>;

export interface AssistantStatus {
  phase: 'idle' | 'starting' | 'running' | 'ended';
  session: string;
  socket: boolean;
  voice: 'off' | 'connecting' | 'connected';
  mode: string;
  destination: string | null;
  camera: string;
  framesSent: number;
  framesSkipped: number;
  accuracy: number | null;
  heading: number | null;
  compass: boolean;
  wakeLock: boolean;
  earconClips: number;
  last: string;
  error: string;
}

// Once per session: it's an aid, not a guarantee (design.md §11).
const FIRST_MESSAGE = "Ready. I give heads-ups, not guarantees.";
const CADENCE_WALK_MS = 1750;
const CADENCE_SCAN_MS = 1000;
const CADENCE_STILL_MS = 4000;
const SETTLE_MS = 3000;
const NGROK = { 'ngrok-skip-browser-warning': '1' };

function sessionId(): string {
  const key = 'cognizant.session';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

export class Assistant {
  private readonly params = new URLSearchParams(location.search);
  private readonly session = sessionId();
  private camera: Camera;
  private sensors = new Sensors();
  private earcons = new Earcons();
  private socket: PhoneSocket;
  private conversation: VoiceSession | null = null;
  private conversationId: string | null = null;

  private running = false;
  private scanning = false;
  private settleUntil = 0;
  private seq = 0;
  private skippedBursts = 0;
  private framesSkipped = 0;
  private wake: (() => void) | null = null;
  private timers: number[] = [];
  private voiceState: AssistantStatus['voice'] = 'off';
  private voiceRetryMs = 2000;
  private agentSpeaking = false;
  private userSpeaking = false;
  private userSpeakingTimer: number | null = null;
  private lastFixSentAt = 0;
  private status: AssistantStatus;

  constructor(
    video: HTMLVideoElement,
    private onStatus: (s: AssistantStatus) => void,
  ) {
    this.camera = new Camera(video);
    this.socket = new PhoneSocket(
      this.session,
      this.params.has('record'),
      (msg) => this.onServerMessage(msg),
      (open) => {
        if (open) {
          // After a reconnect the server needs the pairing and our state again.
          if (this.conversationId) this.socket.send({ type: 'bind', conversationId: this.conversationId });
          this.sendVoice();
          this.sendStatus();
        }
        this.update({ socket: open });
      },
    );
    this.status = {
      phase: 'idle',
      session: this.session,
      socket: false,
      voice: 'off',
      mode: 'helping',
      destination: null,
      camera: '',
      framesSent: 0,
      framesSkipped: 0,
      accuracy: null,
      heading: null,
      compass: false,
      wakeLock: false,
      earconClips: 0,
      last: '',
      error: '',
    };
  }

  private update(patch: Partial<AssistantStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  /**
   * Call directly from the Start tap handler. Everything iOS ties to a user gesture is kicked off
   * here, before anything is awaited: compass permission, audio unlock, camera, mic.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.update({ phase: 'starting', error: '' });
    const compass = this.sensors.requestCompass();
    this.earcons.unlock();
    const camera = this.camera.start();
    const mic = navigator.mediaDevices.getUserMedia({ audio: true });
    this.sensors.startGps((s) => this.onFix(s));
    void this.run(compass, camera, mic);
  }

  private async run(compass: Promise<void>, camera: Promise<void>, mic: Promise<MediaStream>): Promise<void> {
    const [, cameraResult, micResult] = await Promise.allSettled([compass, camera, mic]);
    const errors: string[] = [];
    if (cameraResult.status === 'rejected') errors.push(`L9 camera: ${cameraResult.reason?.message ?? cameraResult.reason}`);
    if (micResult.status === 'rejected') errors.push(`L9 mic: ${micResult.reason?.message ?? micResult.reason}`);
    // Permission is what we needed; the ElevenLabs SDK opens its own mic stream.
    else micResult.value.getTracks().forEach((t) => t.stop());
    if (!this.running) return;

    this.socket.connect();
    await this.sensors.requestWakeLock();
    void this.earcons.preload().then(() => this.update({ earconClips: this.earcons.loaded }));
    this.update({ phase: 'running', camera: this.camera.label, compass: this.sensors.compassGranted, wakeLock: this.sensors.wakeLockHeld, error: errors.join(' · ') });

    document.addEventListener('visibilitychange', this.onVisibility);
    this.timers.push(window.setInterval(() => this.sendStatus(), 10_000));
    void this.startVoice(FIRST_MESSAGE);
    // Ignore frames for a few seconds while the phone settles on the lanyard.
    this.settleUntil = Date.now() + SETTLE_MS;
    void this.captureLoop();
  }

  // ---------------------------------------------------------------- capture

  private async captureLoop(): Promise<void> {
    while (this.running) {
      const started = Date.now();
      if (started >= this.settleUntil && this.camera.live && this.socket.open && document.visibilityState === 'visible') {
        await this.captureOnce();
      }
      const cadence = this.scanning ? CADENCE_SCAN_MS : this.sensors.standingStill ? CADENCE_STILL_MS : CADENCE_WALK_MS;
      const wait = Math.max(50, cadence - (Date.now() - started));
      // A `capture` or `cadence` message from the server cuts the wait short.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, wait);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private async captureOnce(): Promise<void> {
    const frame = await this.camera.burst(this.sensors.upsideDown).catch(() => null);
    if (!frame) {
      // Dark or blurred: not worth an upload. Tell the server when it keeps happening (covered lens).
      this.framesSkipped++;
      if (++this.skippedBursts === 5) this.sendStatus();
      this.update({ framesSkipped: this.framesSkipped });
      return;
    }
    this.skippedBursts = 0;
    const s = this.sensors.state;
    this.socket.sendFrame({
      type: 'frame',
      seq: ++this.seq,
      jpeg: frame.jpeg,
      capturedAt: frame.capturedAt,
      lat: s.lat,
      lng: s.lng,
      accuracy: s.accuracy,
      heading: s.heading,
      width: frame.width,
      height: frame.height,
    });
    this.update({ framesSent: this.socket.framesSent });
  }

  private onFix(s: Sensors['state']): void {
    const now = Date.now();
    if (!this.running || s.lat == null || s.lng == null || now - this.lastFixSentAt < 900) return;
    this.lastFixSentAt = now;
    this.socket.send({ type: 'fix', lat: s.lat, lng: s.lng, accuracy: s.accuracy ?? 999, heading: s.heading, course: s.course, speed: s.speed, at: now });
    this.update({ accuracy: s.accuracy, heading: s.heading });
  }

  private sendStatus(): void {
    this.socket.send({
      type: 'status',
      wakeLock: this.sensors.wakeLockHeld,
      camera: this.camera.live,
      mic: this.voiceState === 'connected',
      battery: null,
      skippedBursts: this.skippedBursts,
    });
    this.update({ wakeLock: this.sensors.wakeLockHeld });
  }

  private onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || !this.running) return;
    // Back from a lock or a background trip: the camera track may have been ended by iOS.
    if (!this.camera.live) void this.camera.start().then(() => this.update({ camera: this.camera.label }), () => {});
    this.sendStatus();
  };

  // ---------------------------------------------------------------- voice (L3)

  private sendVoice(): void {
    this.socket.send({ type: 'voice', agentSpeaking: this.agentSpeaking, userSpeaking: this.userSpeaking, connected: this.voiceState === 'connected' });
  }

  private async startVoice(firstMessage: string): Promise<void> {
    if (!this.running || this.voiceState !== 'off') return;
    this.voiceState = 'connecting';
    this.update({ voice: 'connecting' });
    try {
      const res = await fetch('api/token', { headers: NGROK });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.token) throw new Error(`Failed to get conversation token (L1/L8): ${body?.error?.message ?? res.status}`);
      const conversation = await Conversation.startSession({
        conversationToken: body.token,
        connectionType: 'webrtc',
        overrides: { agent: { firstMessage } },
        onConnect: ({ conversationId }) => {
          this.voiceState = 'connected';
          this.voiceRetryMs = 2000;
          this.conversationId = conversationId;
          // Pairs this conversation (L3) with the engine's connection to the server (L4).
          this.socket.send({ type: 'bind', conversationId });
          this.sendVoice();
          this.sendStatus();
          this.update({ voice: 'connected', error: '' });
        },
        onDisconnect: () => {
          this.conversation = null;
          this.voiceState = 'off';
          this.agentSpeaking = false;
          this.userSpeaking = false;
          this.sendVoice();
          this.update({ voice: 'off' });
          // Reconnect and resume: nav state is on the server.
          if (this.running) this.retryVoice('Reconnected.');
        },
        onModeChange: ({ mode }) => {
          this.agentSpeaking = mode === 'speaking';
          this.sendVoice();
        },
        onVadScore: ({ vadScore }) => {
          if (vadScore < 0.6) return;
          if (!this.userSpeaking) {
            this.userSpeaking = true;
            this.sendVoice();
          }
          if (this.userSpeakingTimer !== null) clearTimeout(this.userSpeakingTimer);
          this.userSpeakingTimer = window.setTimeout(() => {
            this.userSpeaking = false;
            this.sendVoice();
          }, 800);
        },
        onError: (message) => this.update({ error: `L3: ${message}` }),
      });
      if (!this.running) return void conversation.endSession();
      this.conversation = conversation;
    } catch (err) {
      this.voiceState = 'off';
      this.update({ voice: 'off', error: `L3: ${(err as Error).message}` });
      // The data path (frames, GPS, earcons) keeps working without the voice.
      this.retryVoice(firstMessage);
    }
  }

  private retryVoice(firstMessage: string): void {
    const delay = this.voiceRetryMs;
    this.voiceRetryMs = Math.min(delay * 2, 15_000);
    this.timers.push(window.setTimeout(() => void this.startVoice(firstMessage), delay));
  }

  // ---------------------------------------------------------------- server → phone

  private onServerMessage(msg: ServerToPhone): void {
    switch (msg.type) {
      case 'session':
        return this.update({ mode: msg.mode, destination: msg.destination });
      case 'earcon': {
        // Urgent: play the bundled clip now, with the agent muted for its duration.
        const ms = this.earcons.play(msg.clip);
        this.conversation?.setVolume({ volume: 0 });
        this.timers.push(window.setTimeout(() => this.conversation?.setVolume({ volume: 1 }), ms + 150));
        return this.update({ last: `earcon ${msg.clip}` });
      }
      case 'speak':
        // The text lives on the server: it answers this tagged turn with the stored line.
        if (this.voiceState === 'connected') this.conversation?.sendUserMessage(`[nav:${msg.key}]`);
        return this.update({ last: `speak ${msg.key}` });
      case 'capture':
        return this.wake?.();
      case 'cadence':
        this.scanning = msg.mode === 'scan';
        return this.wake?.();
      case 'end':
        // "Turn off": let the goodbye play, then stop everything.
        this.timers.push(window.setTimeout(() => this.stop(), 3500));
        return;
      case 'error':
        return this.update({ error: `${msg.link}: ${msg.message}` });
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    this.timers.forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    this.timers = [];
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.conversation?.endSession().catch(() => {});
    this.conversation = null;
    this.voiceState = 'off';
    this.socket.close();
    this.camera.stop();
    this.sensors.stop();
    this.earcons.close();
    this.update({ phase: 'ended', voice: 'off', socket: false });
  }
}
