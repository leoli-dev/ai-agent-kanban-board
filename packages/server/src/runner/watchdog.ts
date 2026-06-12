export interface WatchdogOpts {
  stuckMs: number;
  wallClockMs: number;
  onStuck: () => void;
  onWallClock: () => void;
}

/**
 * Per-run timers: the stuck timer resets on every engine event (any stdout
 * line counts as a heartbeat); the wall-clock timer never resets.
 */
export class Watchdog {
  private stuckTimer: NodeJS.Timeout | null = null;
  private wallTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private opts: WatchdogOpts) {}

  start(): void {
    this.wallTimer = setTimeout(() => {
      if (!this.stopped) this.opts.onWallClock();
    }, this.opts.wallClockMs);
    this.beat();
  }

  beat(): void {
    if (this.stopped) return;
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => {
      if (!this.stopped) this.opts.onStuck();
    }, this.opts.stuckMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    if (this.wallTimer) clearTimeout(this.wallTimer);
  }
}
