import { describe, expect, it } from 'vitest'
import {
  BACKOFF_SCHEDULE_MS,
  MAX_SYNC_ATTEMPTS,
  NotionRateLimiter,
  backoffMs,
  notionLimiter,
} from '@/lib/notion/limiter'

/**
 * A virtual clock. Time only moves when `drain` or `jump` moves it, so a suite
 * that models an hour of throttling still finishes in milliseconds and never
 * depends on wall clock scheduling.
 */
class FakeClock {
  private t = 0
  private seq = 0
  private timers: { at: number; seq: number; resolve: () => void }[] = []

  now = (): number => this.t

  sleep = (ms: number): Promise<void> => {
    if (!(ms > 0)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + ms, seq: this.seq++, resolve })
    })
  }

  private fireDue(): void {
    const due = this.timers
      .filter((timer) => timer.at <= this.t)
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
    this.timers = this.timers.filter((timer) => timer.at > this.t)
    for (const timer of due) timer.resolve()
  }

  /** Move time forward without waiting for anything. */
  async jump(ms: number): Promise<void> {
    this.t += ms
    this.fireDue()
    await flush()
  }

  /** Run every pending sleep to completion, advancing time as needed. */
  async drain(maxSteps = 10_000): Promise<void> {
    for (let step = 0; step < maxSteps; step++) {
      await flush()
      if (this.timers.length === 0) return
      this.t = Math.max(this.t, Math.min(...this.timers.map((timer) => timer.at)))
      this.fireDue()
    }
    throw new Error('fake clock never settled')
  }
}

/** Let every queued microtask run. setImmediate lands after the microtask queue. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

function makeLimiter(clock: FakeClock, ratePerSecond = 2.5) {
  return new NotionRateLimiter({ ratePerSecond, now: clock.now, sleep: clock.sleep })
}

describe('NotionRateLimiter, defaults', () => {
  it('exports a singleton targeting 2.5 requests per second (section 7.7)', () => {
    expect(notionLimiter).toBeInstanceOf(NotionRateLimiter)
    expect(notionLimiter.ratePerSecond).toBe(2.5)
    expect(notionLimiter.intervalMs).toBe(400)
  })

  it('stays under the ~3/s Notion documents', () => {
    expect(notionLimiter.ratePerSecond).toBeLessThan(3)
  })

  it('rejects a nonsensical rate', () => {
    expect(() => new NotionRateLimiter({ ratePerSecond: 0 })).toThrow(RangeError)
    expect(() => new NotionRateLimiter({ ratePerSecond: -1 })).toThrow(RangeError)
    expect(() => new NotionRateLimiter({ ratePerSecond: Number.NaN })).toThrow(RangeError)
    expect(() => new NotionRateLimiter({ ratePerSecond: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })
})

describe('NotionRateLimiter.run, concurrency', () => {
  it('paces 10 concurrent callers to exactly one interval apart', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []

    const all = Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => {
          starts.push(clock.now())
          return i
        }),
      ),
    )
    await clock.drain()

    expect(await all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(starts).toEqual([0, 400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600])
    // N calls at 2.5/s take (N-1) intervals of virtual time, and no more.
    expect(clock.now()).toBe(3600)
  })

  it('never exceeds the rate over any sliding window', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []

    const all = Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.run(async () => {
          starts.push(clock.now())
        }),
      ),
    )
    await clock.drain()
    await all

    // For every pair, the gap covers at least as many intervals as there are
    // requests between them. That is the sliding window guarantee at every width.
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        expect(starts[j] - starts[i]).toBeGreaterThanOrEqual((j - i) * limiter.intervalMs)
      }
    }
    // Concretely: no one second window holds more than 3 starts.
    for (const start of starts) {
      const inWindow = starts.filter((s) => s >= start && s < start + 1000)
      expect(inWindow.length).toBeLessThanOrEqual(3)
    }
  })

  it('hands out slots in call order', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const order: string[] = []
    const labels = ['a', 'b', 'c', 'd', 'e']

    const all = Promise.all(
      labels.map((label) =>
        limiter.run(async () => {
          order.push(label)
        }),
      ),
    )
    await clock.drain()
    await all

    expect(order).toEqual(labels)
  })

  it('runs the first call with no delay at all', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const value = await limiter.run(async () => 'immediate')
    expect(value).toBe('immediate')
    expect(clock.now()).toBe(0)
  })

  it('honours a custom rate', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock, 4)
    expect(limiter.intervalMs).toBe(250)
    const starts: number[] = []

    const all = Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.run(async () => {
          starts.push(clock.now())
        }),
      ),
    )
    await clock.drain()
    await all

    expect(starts).toEqual([0, 250, 500, 750, 1000])
  })
})

describe('NotionRateLimiter.run, bursts and idling', () => {
  it('banks no burst credit while idle', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []
    const record = async () => {
      starts.push(clock.now())
    }

    await limiter.run(record)
    await clock.jump(10_000) // ten idle seconds

    const all = Promise.all([limiter.run(record), limiter.run(record)])
    await clock.drain()
    await all

    // A bucket with capacity greater than one would fire both of these at once.
    expect(starts).toEqual([0, 10_000, 10_400])
  })

  it('paces dispatch, not completion, so a slow request does not stall the queue', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []

    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })

    const slow = limiter.run(() => blocked)
    const next = limiter.run(async () => {
      starts.push(clock.now())
    })

    await clock.drain()
    expect(starts).toEqual([400])

    release()
    await Promise.all([slow, next])
  })

  it('still consumes the slot when the call throws', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []

    await expect(
      limiter.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const next = limiter.run(async () => {
      starts.push(clock.now())
    })
    await clock.drain()
    await next

    // A failed request still cost quota, so the next one waits a full interval.
    expect(starts).toEqual([400])
  })

  it('keeps pacing across sequential awaited calls', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []

    for (let i = 0; i < 3; i++) {
      const call = limiter.run(async () => {
        starts.push(clock.now())
      })
      await clock.drain()
      await call
    }

    expect(starts).toEqual([0, 400, 800])
  })

  it('reset clears the reservation', async () => {
    const clock = new FakeClock()
    const limiter = makeLimiter(clock)
    const starts: number[] = []
    const record = async () => {
      starts.push(clock.now())
    }

    await limiter.run(record)
    limiter.reset()
    await limiter.run(record)

    expect(starts).toEqual([0, 0])
  })
})

describe('backoffMs (section 7.4 step 6)', () => {
  it('follows the documented schedule', () => {
    expect(backoffMs(1)).toBe(5_000) // 5s
    expect(backoffMs(2)).toBe(30_000) // 30s
    expect(backoffMs(3)).toBe(120_000) // 2m
    expect(backoffMs(4)).toBe(600_000) // 10m
    expect(backoffMs(5)).toBe(3_600_000) // 1h
  })

  it('caps at one hour instead of growing without bound', () => {
    expect(backoffMs(6)).toBe(3_600_000)
    expect(backoffMs(MAX_SYNC_ATTEMPTS)).toBe(3_600_000)
    expect(backoffMs(1_000)).toBe(3_600_000)
  })

  it('clamps garbage input to the first step', () => {
    expect(backoffMs(0)).toBe(5_000)
    expect(backoffMs(-4)).toBe(5_000)
    expect(backoffMs(Number.NaN)).toBe(5_000)
    expect(backoffMs(1.9)).toBe(5_000)
    expect(backoffMs(Number.NEGATIVE_INFINITY)).toBe(5_000)
    expect(backoffMs(Number.POSITIVE_INFINITY)).toBe(5_000)
  })

  it('never decreases', () => {
    for (let attempts = 1; attempts < 12; attempts++) {
      expect(backoffMs(attempts + 1)).toBeGreaterThanOrEqual(backoffMs(attempts))
    }
  })

  it('exposes the schedule and the attempt ceiling', () => {
    expect([...BACKOFF_SCHEDULE_MS]).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000])
    expect(MAX_SYNC_ATTEMPTS).toBe(6)
  })
})
