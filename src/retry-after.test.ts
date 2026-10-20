import { describe, expect, test } from 'bun:test'
import { rateLimitFromError, retryAfterMsFromError } from './retry-after.js'

describe('rateLimitFromError', () => {
	test('reads Retry-After seconds from a Headers-like 429', () => {
		expect(
			rateLimitFromError({
				status: 429,
				headers: {
					get: (name: string) => (name === 'retry-after' ? '2' : null)
				}
			})
		).toEqual({ retryAfterMs: 2_000 })
	})

	test('reads Retry-After from a hanzio-style header record', () => {
		expect(
			rateLimitFromError({
				status: 429,
				responseHeaders: { 'retry-after': '1.5' }
			})
		).toEqual({ retryAfterMs: 1_500 })
	})

	test('returns null retryAfterMs when the 429 has no Retry-After', () => {
		expect(rateLimitFromError({ status: 429 })).toEqual({ retryAfterMs: null })
	})

	test('ignores non-429 errors', () => {
		expect(
			rateLimitFromError({
				status: 500,
				headers: { get: () => '2' }
			})
		).toBeNull()
	})
})

describe('retryAfterMsFromError', () => {
	test('defaults when the 429 has no Retry-After', () => {
		expect(retryAfterMsFromError({ status: 429 })).toBe(1_000)
	})

	test('ignores non-429 errors', () => {
		expect(
			retryAfterMsFromError({
				status: 500,
				headers: { get: () => '2' }
			})
		).toBeNull()
	})
})
