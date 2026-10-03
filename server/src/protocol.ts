// Phone ↔ server messages over /phone (L2, and L11 for replay). design.md §3.
// Type-only for the web app: it imports these with `import type`.

export type Mode = 'helping' | 'navigating';
export type LinkId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'L10' | 'L11';
export type LinkState = 'ok' | 'down' | 'unknown' | 'off';
export interface LinkStatus {
  state: LinkState;
  detail: string;
  at: number;
}

// ---- phone → server ----

export interface HelloMsg {
  type: 'hello';
  session: string;
  replay?: boolean;
  /** Ask the server to save this session to REPLAY_DIR (team walks only). */
  record?: boolean;
  app?: string;
}
export interface BindMsg {
  type: 'bind';
  conversationId: string;
}
export interface FrameMsg {
  type: 'frame';
  seq: number;
  /** base64 JPEG, no data: prefix */
  jpeg: string;
  capturedAt: number;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  heading?: number | null;
  width?: number;
  height?: number;
}
export interface FixMsg {
  type: 'fix';
  lat: number;
  lng: number;
  accuracy: number;
  /** compass, degrees from north */
  heading?: number | null;
  /** GPS course over ground */
  course?: number | null;
  speed?: number | null;
  at: number;
}
export interface StatusMsg {
  type: 'status';
  wakeLock: boolean;
  camera: boolean;
  mic: boolean;
  battery?: number | null;
  /** Bursts in a row the phone threw away as dark or blurred (it doesn't upload those). */
  skippedBursts?: number;
}
/** Who is talking right now, so the gate can wait for a pause. */
export interface VoiceMsg {
  type: 'voice';
  agentSpeaking: boolean;
  userSpeaking: boolean;
  connected: boolean;
}
/** A typed user turn. Replay and desk debugging only — live turns arrive over L4. */
export interface SayMsg {
  type: 'say';
  text: string;
}
export type PhoneToServer = HelloMsg | BindMsg | FrameMsg | FixMsg | StatusMsg | VoiceMsg | SayMsg;

// ---- server → phone ----

export interface SessionMsg {
  type: 'session';
  session: string;
  mode: Mode;
  destination: string | null;
  links: Partial<Record<LinkId, LinkState>>;
}
export interface EarconMsg {
  type: 'earcon';
  clip: EarconClip;
}
export interface SpeakMsg {
  type: 'speak';
  key: string;
  /** Present for replay/debug clients. The phone ignores it: the server answers the [nav:key] turn with the stored line. */
  text?: string;
}
export interface ErrorMsg {
  type: 'error';
  link: LinkId;
  message: string;
}
/** Take a burst right now (a question needs a fresh frame). */
export interface CaptureMsg {
  type: 'capture';
}
/** 'scan' = a frame per second while find is looking; 'walk' = normal cadence. */
export interface CadenceMsg {
  type: 'cadence';
  mode: 'walk' | 'scan';
}
/** "Turn off": the phone ends the session once the goodbye has played. */
export interface EndMsg {
  type: 'end';
}
export type ServerToPhone = SessionMsg | EarconMsg | SpeakMsg | ErrorMsg | CaptureMsg | CadenceMsg | EndMsg;

// ---- earcons: pre-generated clips in the ElevenLabs voice, bundled in web/public/earcons ----

export const EARCONS = {
  stop: 'Stop.',
  stairs_ahead: 'Stairs ahead.',
  obstacle_left: 'Obstacle on your left.',
  obstacle_ahead: 'Obstacle ahead.',
  obstacle_right: 'Obstacle on your right.',
} as const;
export type EarconClip = keyof typeof EARCONS;

export const navTag = (key: string) => `[nav:${key}]`;
export const NAV_TAG_RE = /^\s*\[nav:([^\]]+)\]\s*$/;
