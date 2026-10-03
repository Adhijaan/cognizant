// L9: GPS, compass and screen wake lock. All of them need the Start tap (design.md §5).

export interface SensorState {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  /** compass, degrees from north */
  heading: number | null;
  /** GPS course over ground */
  course: number | null;
  speed: number | null;
  /** deviceorientation beta: ~90 hanging upright, ~-90 upside down */
  beta: number | null;
  fixAt: number;
}

type OrientationEventWithCompass = DeviceOrientationEvent & { webkitCompassHeading?: number };
type OrientationPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export class Sensors {
  state: SensorState = { lat: null, lng: null, accuracy: null, heading: null, course: null, speed: null, beta: null, fixAt: 0 };
  compassGranted = false;
  wakeLockHeld = false;
  private watchId: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private onOrientation = (e: DeviceOrientationEvent) => {
    const compass = (e as OrientationEventWithCompass).webkitCompassHeading;
    if (typeof compass === 'number' && Number.isFinite(compass)) this.state.heading = compass;
    else if (e.absolute && e.alpha != null) this.state.heading = (360 - e.alpha) % 360;
    if (e.beta != null) this.state.beta = e.beta;
  };
  private onVisibility = () => {
    // The wake lock is released whenever the page is hidden: take it again when we come back.
    if (document.visibilityState === 'visible') void this.requestWakeLock();
  };

  /**
   * Must be called synchronously inside the tap handler, before anything is awaited:
   * iOS only shows the motion/compass prompt from a user gesture.
   */
  requestCompass(): Promise<void> {
    const ctor = window.DeviceOrientationEvent as unknown as OrientationPermission | undefined;
    const granted = () => {
      this.compassGranted = true;
      window.addEventListener('deviceorientation', this.onOrientation);
    };
    if (ctor?.requestPermission) {
      return ctor
        .requestPermission()
        .then((result) => {
          if (result === 'granted') granted();
        })
        .catch(() => {});
    }
    if ('DeviceOrientationEvent' in window) granted();
    return Promise.resolve();
  }

  startGps(onFix: (s: SensorState) => void): void {
    if (!('geolocation' in navigator)) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        Object.assign(this.state, {
          lat: c.latitude,
          lng: c.longitude,
          accuracy: c.accuracy,
          course: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null,
          speed: c.speed != null && !Number.isNaN(c.speed) ? c.speed : null,
          fixAt: Date.now(),
        });
        onFix(this.state);
      },
      () => {}, // denied or unavailable: the helping branch still works without GPS
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  async requestWakeLock(): Promise<void> {
    try {
      if (!('wakeLock' in navigator) || this.wakeLockHeld) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLockHeld = true;
      this.wakeLock.addEventListener('release', () => {
        this.wakeLockHeld = false;
      });
      document.addEventListener('visibilitychange', this.onVisibility);
    } catch {
      this.wakeLockHeld = false;
    }
  }

  /** Walking, by GPS speed. Unknown speed (indoors) counts as walking so the cadence stays up. */
  get standingStill(): boolean {
    return this.state.speed != null && Date.now() - this.state.fixAt < 5000 && this.state.speed < 0.3;
  }

  get upsideDown(): boolean {
    return this.state.beta != null && this.state.beta < -45;
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    window.removeEventListener('deviceorientation', this.onOrientation);
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.wakeLock?.release().catch(() => {});
  }
}
