/** Simple sliding-window rate limiter (in-process). */

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const arr = (this.hits.get(key) || []).filter((t) => t >= windowStart);
    if (arr.length >= this.maxHits) {
      throw new Error("rate limit exceeded");
    }
    arr.push(now);
    this.hits.set(key, arr);
  }
}
