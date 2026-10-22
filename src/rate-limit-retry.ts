import {
	exponentialBackoff,
	getAtPath,
	isNumber,
	isRecord,
	isString,
	safeJsonParse
} from 'hanzio'

/**
 * Bounded retries for Cloudflare 429s (Workers AI code 971 / Browser Rendering).
 *
 * The Redis concurrency limiter already waits out a shared cooldown once
 * `tripCooldown` is called. This helper trips that cooldown, then re-enters the
 * limited call so the next attempt only starts after the fleet-wide pause.
 * Hanzio's own retries stay off for these clients: retrying while still holding
 * a slot stampedes the upstream before the cooldown can take effect.
 */

export class CloudflareRateLimitedError extends Error {
	override readonly name = 'CloudflareRateLimitedError'

	constructor(
		readonly event: string,
		readonly attempts: number
	) {
		super(`${event} rate limit exhausted after ${attempts} attempt(s)`)
	}
}

export const CLOUDFLARE_RATE_LIMIT_MAX_ATTEMPTS = 4
/** Wall-clock budget for waiting out 429s inside one conversion call. */
export const CLOUDFLARE_RATE_LIMIT_BUDGET_MS = 45_000
const DEFAULT_BACKOFF_MS = 2_000
const THROTTLE_971_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 20_000

export function cloudflareErrorCode(error: unknown): number | null {
	if (!isRecord(error)) return null
	const bodyJson =
		error.bodyJson && typeof error.bodyJson === 'object'
			? error.bodyJson
			: isString(error.body) && error.body
				? safeJsonParse(error.body).data
				: null
	const code = getAtPath(bodyJson, ['errors', 0, 'code'])
	return isNumber(code) ? code : null
}

/**
 * Backoff for a 429: honor `Retry-After` when present, otherwise exponential
 * with jitter. Cloudflare code 971 ("throttle your request speed") gets a
 * longer floor than a bare 429 with no header.
 */
export function rateLimitBackoffMs(
	error: unknown,
	attempt: number,
	retryAfterMs: number | null,
	random: () => number = Math.random
) {
	const floor =
		cloudflareErrorCode(error) === 971
			? THROTTLE_971_BACKOFF_MS
			: DEFAULT_BACKOFF_MS
	const exponential = exponentialBackoff(attempt, {
		baseMs: floor,
		maxMs: MAX_BACKOFF_MS,
		jitter: false
	})
	const base = Math.min(MAX_BACKOFF_MS, retryAfterMs ?? exponential)
	const jitter = Math.floor(random() * Math.max(250, base * 0.2))
	return base + jitter
}

export async function withCloudflareRateLimitRetry<T>(input: {
	event: string
	signal?: AbortSignal | undefined
	maxAttempts?: number
	budgetMs?: number
	/**
	 * `null` = not a rate limit. Otherwise `retryAfterMs` is the parsed
	 * `Retry-After` header, or `null` when the 429 omitted one.
	 */
	rateLimitFromError: (error: unknown) => { retryAfterMs: number | null } | null
	tripCooldown: (waitMs: number) => Promise<void>
	run: () => Promise<T>
	onRateLimit?: (info: {
		attempt: number
		waitMs: number
		error: unknown
	}) => void
	random?: () => number
	now?: () => number
}): Promise<T> {
	const maxAttempts = input.maxAttempts ?? CLOUDFLARE_RATE_LIMIT_MAX_ATTEMPTS
	const budgetMs = input.budgetMs ?? CLOUDFLARE_RATE_LIMIT_BUDGET_MS
	const now = input.now ?? Date.now
	const startedAt = now()
	let attempt = 0

	while (true) {
		attempt++
		input.signal?.throwIfAborted()
		try {
			return await input.run()
		} catch (error) {
			const rateLimit = input.rateLimitFromError(error)
			if (!rateLimit) throw error

			const waitMs = rateLimitBackoffMs(
				error,
				attempt,
				rateLimit.retryAfterMs,
				input.random
			)
			input.onRateLimit?.({ attempt, waitMs, error })
			await input.tripCooldown(waitMs)

			const elapsedMs = now() - startedAt
			const budgetLeftMs = budgetMs - elapsedMs
			if (
				attempt >= maxAttempts ||
				budgetLeftMs < waitMs ||
				input.signal?.aborted
			) {
				throw new CloudflareRateLimitedError(input.event, attempt)
			}
			// The next `run()` re-enters the Redis limiter, which blocks until the
			// cooldown we just tripped expires (plus start-rate headroom).
		}
	}
}
