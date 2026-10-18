export type Quality = 'low' | 'medium' | 'high';
export type Graphics = 'auto' | Quality;
export const PIXEL_RATIO: Readonly<Record<Quality, number>> = { low: 1, medium: 1.5, high: 2 };
/** Measurement window and sustained-pressure timer use the caller's monotonic clock. */
export class AutoQuality {
  #samples: {
    at: number;
    ms: number;
  }[] = [];
  #slowSince: number | null = null;
  #level: Quality = 'medium';
  #setting: Graphics = 'auto';
  get level(): Quality {
    return this.#setting === 'auto' ? this.#level : this.#setting;
  }
  get p95(): number {
    const sorted = this.#samples.map((s) => s.ms).sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  }
  set(setting: Graphics): void {
    this.#setting = setting;
    this.#slowSince = null;
  }
  sample(ms: number, now: number): boolean {
    this.#samples.push({ at: now, ms });
    this.#samples = this.#samples.filter((s) => s.at >= now - 1000);
    if (this.#setting !== 'auto' || this.p95 <= 16) {
      this.#slowSince = null;
      return false;
    }
    this.#slowSince ??= now;
    if (now - this.#slowSince < 3000 || this.#level === 'low') return false;
    this.#level = this.#level === 'high' ? 'medium' : 'low';
    this.#slowSince = null;
    return true;
  }
}
