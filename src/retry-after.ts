import { clamp, isFunction, isRecord, parseRetryAfter } from 'hanzio'

const DEFAULT_RETRY_AFTER_MS = 1_000
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000

function headerGet(headers: unknown, name: string): string | null {
	if (!isRecord(headers)) return null
	if (isFunction(headers.get)) return headers.get(name)
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
	if (!isRecord(error) || error.status !== 429) return null

	const raw =
		headerGet(error.headers, 'retry-after') ??
		headerGet(error.responseHeaders, 'retry-after')
	const parsed = parseRetryAfter(raw)
	return {
		retryAfterMs:
			parsed === undefined
				? null
				: clamp(Math.ceil(parsed), 0, MAX_RETRY_AFTER_MS)
	}
}

/** Wait ms for a 429, with a 1s default when `Retry-After` is missing. */
export function retryAfterMsFromError(error: unknown) {
	const info = rateLimitFromError(error)
	if (!info) return null
	return clamp(
		Math.ceil(info.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS),
		0,
		MAX_RETRY_AFTER_MS
	)
}
