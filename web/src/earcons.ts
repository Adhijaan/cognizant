// Earcons: short clips in the ElevenLabs voice, bundled with the app and played the moment an urgent
// result arrives — no conversation round trip (design.md §5). Until the clips are generated
// (`npm run earcons:generate`), each one falls back to a distinct tone pattern.

import { EARCONS, type EarconClip } from '../../server/src/protocol.ts';

// [frequency Hz, duration ms] per beep
const TONES: Record<EarconClip, [number, number][]> = {
  stop: [[880, 140], [880, 140], [880, 140]],
  stairs_ahead: [[520, 140], [660, 140], [800, 140]],
  obstacle_left: [[440, 200], [440, 200]],
  obstacle_ahead: [[660, 320]],
  obstacle_right: [[880, 200], [880, 200]],
};

export class Earcons {
  private ctx: AudioContext | null = null;
  private buffers = new Map<EarconClip, AudioBuffer>();

  /**
   * Must be called synchronously inside the Start tap: iOS only lets audio play once a context
   * has been resumed from a user gesture.
   */
  unlock(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    void this.ctx.resume();
    const silent = this.ctx.createBufferSource();
    silent.buffer = this.ctx.createBuffer(1, 1, 22050);
    silent.connect(this.ctx.destination);
    silent.start(0);
  }

  async preload(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      (Object.keys(EARCONS) as EarconClip[]).map(async (clip) => {
        try {
          // Relative URL (never mixed content); the header skips free-tier ngrok's interstitial.
          const res = await fetch(`earcons/${clip}.mp3`, { headers: { 'ngrok-skip-browser-warning': '1' } });
          if (!res.ok || !/audio|octet-stream/.test(res.headers.get('content-type') ?? '')) return;
          this.buffers.set(clip, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          // not generated yet: the tone fallback is used
        }
      }),
    );
  }

  get loaded(): number {
    return this.buffers.size;
  }

  /** Plays the clip now and returns how long it lasts, in ms. */
  play(clip: EarconClip): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (ctx.state !== 'running') void ctx.resume();
    const buffer = this.buffers.get(clip);
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
      return buffer.duration * 1000;
    }
    let t = ctx.currentTime;
    for (const [freq, ms] of TONES[clip] ?? TONES.obstacle_ahead) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.6, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + ms / 1000 + 0.02);
      t += ms / 1000 + 0.06;
    }
    return (t - ctx.currentTime) * 1000;
  }

  close(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
