/**
 * The single throttle every Notion request goes through. Section 7.7.
 *
 * Notion documents an average of about three requests per second, so we target
 * 2.5 to leave headroom for retries and for anything else touching the token.
 *
 * The bucket holds exactly one token. A bucket with burst capacity would let an
 * idle period bank credit and then fire a burst, which is fine for an *average*
 * rate but not for the guarantee we want: no sliding window of any width may
 * contain more requests than the rate allows. With capacity one, the k-th and
 * the (k+n)-th request are always at least n intervals apart, at every n.
 */

export type NotionRateLimiterOptions = {
  /** Requests per second. Defaults to 2.5. */
  ratePerSecond?: number
  /**
   * Monotonic millisecond clock. Defaults to `performance.now`, not `Date.now`,
   * so an NTP step cannot hand out a pile of slots at once. Tests inject a fake.
   */
  now?: () => number
  /** Must resolve no earlier than `ms` on the same clock as `now`. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_RATE_PER_SECOND = 2.5

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export class NotionRateLimiter {
  readonly ratePerSecond: number
  /** Minimum spacing between two request starts. */
  readonly intervalMs: number

  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  /**
   * The earliest time the next slot may start. Reserved synchronously, so the
   * order slots are handed out is the order `run` was called in, with no window
   * for a concurrent caller to interleave and take the same slot.
   */
  private nextSlotAt = Number.NEGATIVE_INFINITY

  constructor(options: NotionRateLimiterOptions = {}) {
    const rate = options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new RangeError(`ratePerSecond must be a positive finite number, received ${rate}`)
    }
    this.ratePerSecond = rate
    this.intervalMs = 1000 / rate
    this.now = options.now ?? (() => performance.now())
    this.sleep = options.sleep ?? realSleep
  }

  /**
   * Take the next slot, wait for it, then invoke `fn`.
   *
   * The slot is consumed whether or not `fn` succeeds, which is what we want:
   * a request that failed still cost us quota.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const startAt = this.reserve()
    // Loop rather than sleep once: a real timer may fire a hair early, and a
    // caller's `sleep` is only promised not to return *before* the deadline.
    while (this.now() < startAt) {
      await this.sleep(startAt - this.now())
    }
    return fn()
  }

  /** Synchronous, and the only writer of `nextSlotAt`. Do not make this async. */
  private reserve(): number {
    const startAt = Math.max(this.now(), this.nextSlotAt)
    this.nextSlotAt = startAt + this.intervalMs
    return startAt
  }

  /** Drop any reservation. Tests and process-level resets only. */
  reset(): void {
    this.nextSlotAt = Number.NEGATIVE_INFINITY
  }
}

/** The process-wide limiter. Every Notion call goes through this one. */
export const notionLimiter = new NotionRateLimiter()

/** Section 7.4 step 6: 5s, 30s, 2m, 10m, 1h. */
export const BACKOFF_SCHEDULE_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const

/** Section 7.4 step 6: "After 6 attempts mark failed". */
export const MAX_SYNC_ATTEMPTS = 6

/**
 * Delay before retry number `attempts`, where `attempts` is the already
 * incremented failure count, so the first failure is `backoffMs(1)` = 5s.
 * Past the end of the schedule the delay caps at one hour rather than growing.
 */
export function backoffMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.floor(attempts) : 1
  const index = Math.min(Math.max(n, 1), BACKOFF_SCHEDULE_MS.length) - 1
  return BACKOFF_SCHEDULE_MS[index]
}
