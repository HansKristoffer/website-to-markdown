import type { ConcurrencyLimit, ConcurrencyLimitOptions } from './limit.js'

const START_WINDOW_MS = 1_000

/**
 * The default limiter: `max` callbacks in flight, at most `maxStartsPerSecond`
 * starts in any second, and a `tripCooldown` pause before the next start.
 *
 * ponytail: per-process only. Several processes sharing one Cloudflare quota
 * need a shared limiter (hellu passes its Redis Lua limiter).
 */
export function createMemoryConcurrencyLimit(
	options: ConcurrencyLimitOptions
): ConcurrencyLimit {
	let active = 0
	let cooldownUntil = 0
	const starts: number[] = []
	const wakers = new Set<() => void>()

	function wakeAll() {
		for (const wake of [...wakers]) wake()
	}

	/** Resolves after `ms`, on the next release (`ms` null), or on abort. */
	function sleep(ms: number | null, signal?: AbortSignal) {
		return new Promise<void>((resolve) => {
			const timer = ms === null ? undefined : setTimeout(done, ms)
			wakers.add(done)
			signal?.addEventListener('abort', done, { once: true })
			function done() {
				clearTimeout(timer)
				wakers.delete(done)
				signal?.removeEventListener('abort', done)
				resolve()
			}
		})
	}

	/** 0 when a slot can be taken now, null to wait for a release, else ms. */
	function waitMs(now: number) {
		while (starts[0] !== undefined && starts[0] <= now - START_WINDOW_MS)
			starts.shift()
		if (cooldownUntil > now) return cooldownUntil - now
		if (active >= options.max) return null
		const oldest = starts[0]
		if (
			options.maxStartsPerSecond &&
			oldest !== undefined &&
			starts.length >= options.maxStartsPerSecond
		) {
			return oldest + START_WINDOW_MS - now
		}
		return 0
	}

	const limit = async <T>(run: () => Promise<T>, signal?: AbortSignal) => {
		while (true) {
			signal?.throwIfAborted()
			const now = Date.now()
			const wait = waitMs(now)
			if (wait === 0) {
				active++
				if (options.maxStartsPerSecond) starts.push(now)
				break
			}
			await sleep(wait, signal)
		}
		try {
			return await run()
		} finally {
			active--
			wakeAll()
		}
	}
	limit.tripCooldown = async (waitMs: number) => {
		cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs)
	}
	limit.dispose = () => {}
	return limit
}
