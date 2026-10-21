import { createMemoryConcurrencyLimit } from './memory-limit.js'

/**
 * A semaphore: at most `max` callbacks in flight. `hanzio/redis`'s
 * `createRedisConcurrencyLimit` returns this shape (plus `queueDepth`, which is
 * not needed here) once `send` is bound; the default is
 * {@link createMemoryConcurrencyLimit}.
 */
export type ConcurrencyLimit = {
	<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>
	/** Pause every start for `waitMs`, e.g. from an upstream `Retry-After`. */
	tripCooldown: (waitMs: number) => Promise<void>
	/** Drop the limiter's timers and metric registrations; it is discarded. */
	dispose: () => void
}

export type ConcurrencyLimitOptions = {
	/** Shared limiters key their state on this; one per pool or host. */
	key: string
	max: number
	/** How long a slot held by a crashed process stays taken. */
	slotTtlMs: number
	/** A separate sliding one-second window of starts (provider rps quotas). */
	maxStartsPerSecond?: number
	/** The pool a per-host limiter reports metrics under, instead of its key. */
	metricLabel?: string
}

export type CreateConcurrencyLimit = (
	options: ConcurrencyLimitOptions
) => ConcurrencyLimit

/**
 * Page-level fetch parallelism. Content negotiation is a plain GET and is not
 * a Cloudflare API call, so this can sit above the Workers Paid start rates.
 * Workers AI and Browser Rendering still queue on their own pools.
 */
export const URL_TO_MARKDOWN_PAGE_CONCURRENCY = 80

/**
 * Workers Paid Quick Actions are 30 rps, not 30 in-flight. Leave a little
 * headroom so two processes cannot land a burst on the same clock second.
 * Concurrency is higher so a 10-20s render does not leave the rps budget idle.
 */
export const CLOUDFLARE_BROWSER_RENDERING_MAX_RPS = 28
export const CLOUDFLARE_BROWSER_RENDERING_MAX_CONCURRENCY = 80

/**
 * toMarkdown has no published rps cap. Stay below the Client API 200/s IP
 * burst and let `tripCooldown` pull the fleet back if the 1200/5min token
 * window applies.
 */
export const CLOUDFLARE_WORKERS_AI_MAX_RPS = 12
export const CLOUDFLARE_WORKERS_AI_MAX_CONCURRENCY = 24

/** The two Cloudflare pools; a page can wait on both and on its host. */
export function createCloudflareLimits(createLimit: CreateConcurrencyLimit) {
	return {
		browserRendering: createLimit({
			key: 'cloudflare-browser-rendering',
			max: CLOUDFLARE_BROWSER_RENDERING_MAX_CONCURRENCY,
			maxStartsPerSecond: CLOUDFLARE_BROWSER_RENDERING_MAX_RPS,
			// Browser Rendering can run up to 60s; TTL is crash detection, not a budget.
			slotTtlMs: 90_000
		}),
		workersAi: createLimit({
			key: 'cloudflare-workers-ai',
			max: CLOUDFLARE_WORKERS_AI_MAX_CONCURRENCY,
			maxStartsPerSecond: CLOUDFLARE_WORKERS_AI_MAX_RPS,
			slotTtlMs: 45_000
		})
	}
}

/**
 * Politeness cap per customer host. This is the only thing standing
 * between an 80-wide page pool and one small WordPress box, and it applies to a
 * SOLO import as much as a concurrent one: two orgs are two domains and never
 * contend, so the burst this prevents is a single site's own crawl.
 *
 * Deliberately generous rather than cautious - a healthy origin should be read
 * at speed, and 500 pages at 16 in flight is well inside the run timeout. It
 * stays a cap because the failure it prevents is silent and un-retryable: a WAF
 * that decides we are an attack blocks the whole import, and the customer-site
 * probe already found an origin that 403s on User-Agent alone.
 *
 * Separate from the Cloudflare pools - a page can wait on both.
 */
export const URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY = 16

/**
 * A host that answered 429 is read this narrowly from then on. At 16 in
 * flight Shopify refused 117 of Good Habit's 244 reads even after each had
 * waited out its pause: the pause only delayed the next burst. Calibration
 * knobs - set them from the crawl log's `rate_limited`, not by theory.
 */
export const URL_TO_MARKDOWN_THROTTLED_HOST_MAX_CONCURRENCY = 2
const THROTTLED_HOST_STARTS_PER_SECOND = 2

/** A throttled host is read at the full cap again after this long without a 429. */
const HOST_THROTTLE_MS = 15 * 60 * 1000

/**
 * Every host limiter meters under this one label. Per-host series would grow
 * with the customer base and never shrink, and the question the metric answers
 * - is the crawler backed up behind origins - is a pool-wide question anyway.
 */
const HOST_METRIC_LABEL = 'url-to-markdown:host'

/** Ceiling on live host limiters, and so on the closures the gauge retains. */
export const URL_TO_MARKDOWN_HOST_LIMIT_CACHE_MAX = 512

type HostEntry = {
	limit: ConcurrencyLimit
	inFlight: number
	/** Set by the host's first 429 (`coolDownHost`); every read passes it too. */
	throttle: ConcurrencyLimit | null
	throttledUntil: number
}

/** Limiters are per host and created on demand; one per request would leak pumps. */
export function createHostLimits(
	createLimit: CreateConcurrencyLimit = createMemoryConcurrencyLimit
) {
	// Insertion order is maintained as LRU order: a hit re-inserts, so the
	// eviction scan starts at the host we have not touched in the longest.
	const entries = new Map<string, HostEntry>()

	function evictIdle() {
		if (entries.size < URL_TO_MARKDOWN_HOST_LIMIT_CACHE_MAX) return
		for (const [host, entry] of entries) {
			if (entry.inFlight > 0) continue
			// Disposing drops the metric registration, and with it the closure
			// that would otherwise retain this limiter for the life of the process.
			entry.limit.dispose()
			entry.throttle?.dispose()
			entries.delete(host)
			return
		}
		// Every cached host is busy. Running over the cap beats disposing a
		// limiter whose slots are still held and still being heartbeated.
	}

	function getEntry(hostname: string) {
		const key = hostname.toLowerCase()
		const cached = entries.get(key)
		if (cached) {
			entries.delete(key)
			entries.set(key, cached)
			return cached
		}
		evictIdle()
		const entry: HostEntry = {
			limit: createLimit({
				key: `url-to-markdown:host:${key}`,
				metricLabel: HOST_METRIC_LABEL,
				max: URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY,
				// Origin fetches time out at 30s; the TTL only has to outlive that.
				slotTtlMs: 45_000
			}),
			inFlight: 0,
			throttle: null,
			throttledUntil: 0
		}
		entries.set(key, entry)
		return entry
	}

	return {
		async withHostLimit<T>(hostname: string, run: () => Promise<T>) {
			const entry = getEntry(hostname)
			// Counted around the whole wait+run so eviction can tell a limiter that
			// is merely cached from one that is holding slots right now.
			entry.inFlight++
			try {
				return await entry.limit(() => {
					// A lapsed throttle is kept for the host's next 429; eviction disposes it.
					const throttle =
						Date.now() < entry.throttledUntil ? entry.throttle : null
					return throttle ? throttle(run) : run()
				})
			} finally {
				entry.inFlight--
			}
		},

		/**
		 * The host answered 429: from now on it is read at the throttled cap, and
		 * nothing is sent to it for `waitMs`. A shared limiter shares the pause, so
		 * every worker reading the host waits it out. True when this 429 is what
		 * narrowed the host.
		 */
		async coolDownHost(hostname: string, waitMs: number) {
			const entry = getEntry(hostname)
			const narrowed = Date.now() >= entry.throttledUntil
			entry.throttle ??= createLimit({
				key: `url-to-markdown:host:${hostname.toLowerCase()}:throttled`,
				metricLabel: HOST_METRIC_LABEL,
				max: URL_TO_MARKDOWN_THROTTLED_HOST_MAX_CONCURRENCY,
				maxStartsPerSecond: THROTTLED_HOST_STARTS_PER_SECOND,
				slotTtlMs: 45_000
			})
			entry.throttledUntil = Date.now() + HOST_THROTTLE_MS
			await entry.throttle.tripCooldown(waitMs)
			return narrowed
		}
	}
}
