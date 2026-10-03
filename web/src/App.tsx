import { useEffect, useRef, useState } from 'react';
import { Assistant, type AssistantStatus } from './assistant.ts';

const LONG_PRESS_MS = 3000;
const debug = new URLSearchParams(location.search).has('debug');

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const assistant = useRef<Assistant | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const active = status?.phase === 'starting' || status?.phase === 'running';

  // One control. Everything iOS needs a tap for starts inside this handler.
  const start = () => {
    assistant.current = new Assistant(video.current!, setStatus);
    assistant.current.start();
  };

  // While running the screen is against the body: swallow every touch. A long press is the backup
  // for "turn off". React's touch listeners are passive, so these are attached directly.
  useEffect(() => {
    const el = screen.current;
    if (!active || !el) return;
    let timer: number | undefined;
    const down = (e: Event) => {
      e.preventDefault();
      clearTimeout(timer);
      timer = window.setTimeout(() => assistant.current?.stop(), LONG_PRESS_MS);
    };
    const up = (e: Event) => {
      e.preventDefault();
      clearTimeout(timer);
    };
    const swallow = (e: Event) => e.preventDefault();
    const opts = { passive: false } as const;
    el.addEventListener('touchstart', down, opts);
    el.addEventListener('touchend', up, opts);
    el.addEventListener('touchcancel', up, opts);
    el.addEventListener('touchmove', swallow, opts);
    el.addEventListener('contextmenu', swallow);
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
      el.removeEventListener('touchmove', swallow);
      el.removeEventListener('contextmenu', swallow);
      el.removeEventListener('mousedown', down);
      el.removeEventListener('mouseup', up);
    };
  }, [active]);

  useEffect(() => () => assistant.current?.stop(), []);

  return (
    <>
      <video ref={video} className="camera" playsInline muted autoPlay />
      {active ? (
        <div ref={screen} className="running" aria-label="Assistant running. Say turn off to stop.">
          {debug && status && <pre className="debug">{debugText(status)}</pre>}
        </div>
      ) : (
        <button className="start" onClick={start} aria-label="Start the assistant">
          Start
          {status?.error && <small>{status.error}</small>}
        </button>
      )}
    </>
  );
}

const debugText = (s: AssistantStatus) =>
  [
    `session ${s.session}  ${s.phase}  mode ${s.mode}${s.destination ? ` → ${s.destination}` : ''}`,
    `L2 socket ${s.socket ? 'open' : 'closed'}   L3 voice ${s.voice}`,
    `L9 camera ${s.camera || '-'}  compass ${s.compass ? 'ok' : 'no'}  wake lock ${s.wakeLock ? 'ok' : 'no'}`,
    `frames sent ${s.framesSent}  skipped ${s.framesSkipped}  earcon clips ${s.earconClips}/5`,
    `gps accuracy ${s.accuracy == null ? '-' : `${Math.round(s.accuracy)} m`}  heading ${s.heading == null ? '-' : Math.round(s.heading)}`,
    s.last && `last ${s.last}`,
    s.error && `error ${s.error}`,
  ]
    .filter(Boolean)
    .join('\n');
