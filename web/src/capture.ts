// Frame capture (design.md §5): a burst of 3 frames ~150 ms apart, keep the sharpest, skip the burst
// if all are dark or blurred, downscale to 512 px, JPEG. Frames stay in memory only.

const LONG_EDGE = 512;
const BURST = 3;
const BURST_GAP_MS = 150;
const JPEG_QUALITY = 0.7;
const SCORE_WIDTH = 96;
// Tune on the actual phone: mean luma 0–255, and Laplacian variance on the small gray copy.
const MIN_BRIGHTNESS = 18;
const MIN_SHARPNESS = 12;

export interface CapturedFrame {
  jpeg: string;
  width: number;
  height: number;
  capturedAt: number;
  sharpness: number;
  brightness: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Camera {
  stream: MediaStream | null = null;
  label = '';
  private canvas = document.createElement('canvas');
  private score = document.createElement('canvas');

  constructor(private video: HTMLVideoElement) {}

  /** Call inside the Start tap. Starts with the back camera, then switches to the ultra-wide if Safari lists one. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
    });
    // Labels are only readable once permission is granted. Chest height misses high signs and curbs: wider is better.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const ultraWide = devices.find((d) => d.kind === 'videoinput' && /ultra/i.test(d.label) && /back/i.test(d.label));
      const current = this.stream.getVideoTracks()[0];
      if (ultraWide && current.getSettings().deviceId !== ultraWide.deviceId) {
        const wide = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: ultraWide.deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } } });
        current.stop();
        this.stream = wide;
      }
    } catch {
      // keep the default back camera
    }
    this.label = this.stream.getVideoTracks()[0]?.label ?? '';
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
  }

  get live(): boolean {
    return this.stream?.getVideoTracks()[0]?.readyState === 'live';
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** The sharpest frame of a burst, or null if every frame was dark or blurred. */
  async burst(rotate180: boolean): Promise<CapturedFrame | null> {
    let best: CapturedFrame | null = null;
    for (let i = 0; i < BURST; i++) {
      if (i > 0) await sleep(BURST_GAP_MS);
      const frame = this.grab(rotate180);
      if (frame && (!best || frame.sharpness > best.sharpness)) best = frame;
    }
    if (!best || best.brightness < MIN_BRIGHTNESS || best.sharpness < MIN_SHARPNESS) return null;
    return best;
  }

  private grab(rotate180: boolean): CapturedFrame | null {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return null;
    const scale = LONG_EDGE / Math.max(v.videoWidth, v.videoHeight);
    const width = Math.round(v.videoWidth * scale);
    const height = Math.round(v.videoHeight * scale);
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d')!;
    if (rotate180) {
      // The phone is hanging upside down: turn the picture the right way up before upload.
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(v, 0, 0, width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const { sharpness, brightness } = this.measure(width, height);
    return { jpeg: this.canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1], width, height, capturedAt: Date.now(), sharpness, brightness };
  }

  /** Laplacian variance and mean brightness on a small gray copy. */
  private measure(width: number, height: number): { sharpness: number; brightness: number } {
    const w = SCORE_WIDTH;
    const h = Math.max(8, Math.round((height / width) * w));
    this.score.width = w;
    this.score.height = h;
    const ctx = this.score.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.canvas, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) {
      const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      gray[i] = g;
      sum += g;
    }
    let lapSum = 0;
    let lapSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
        lapSum += lap;
        lapSq += lap * lap;
        n++;
      }
    }
    const mean = lapSum / n;
    return { sharpness: lapSq / n - mean * mean, brightness: sum / (w * h) };
  }
}
