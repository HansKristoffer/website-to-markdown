import { parseRetryAfter } from 'hanzio'

const DEFAULT_RETRY_AFTER_MS = 1_000
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000

function headerGet(headers: unknown, name: string): string | null {
	if (!headers || typeof headers !== 'object') return null
	if (typeof (headers as { get?: unknown }).get === 'function') {
		return (headers as { get: (key: string) => string | null }).get(name)
	}
	const record = headers as Record<string, string>
	return record[name] ?? record[name.toLowerCase()] ?? null
}

/**
 * `null` when the error is not an HTTP 429. Otherwise `retryAfterMs` is the
 * parsed `Retry-After` header, or `null` when the 429 omitted one (callers
 * that need a wait should fall back to exponential backoff).
 */
export function rateLimitFromError(
	error: unknown
): { retryAfterMs: number | null } | null {
	if (typeof error !== 'object' || !error) return null
	const status =
		'status' in error && typeof error.status === 'number' ? error.status : null
	if (status !== 429) return null

	const raw =
		headerGet('headers' in error ? error.headers : null, 'retry-after') ??
		headerGet(
			'responseHeaders' in error ? error.responseHeaders : null,
			'retry-after'
		)
	const parsed = parseRetryAfter(raw)
	return {
		retryAfterMs:
			parsed === undefined
				? null
				: Math.min(MAX_RETRY_AFTER_MS, Math.ceil(parsed))
	}
}

/** Wait ms for a 429, with a 1s default when `Retry-After` is missing. */
export function retryAfterMsFromError(error: unknown) {
	const info = rateLimitFromError(error)
	if (!info) return null
	return Math.min(
		MAX_RETRY_AFTER_MS,
		Math.ceil(info.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)
	)
}
