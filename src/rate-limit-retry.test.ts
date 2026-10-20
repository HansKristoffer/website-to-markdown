import { describe, expect, mock, test } from 'bun:test'
import {
	CloudflareRateLimitedError,
	cloudflareErrorCode,
	rateLimitBackoffMs,
	withCloudflareRateLimitRetry
} from './rate-limit-retry.js'

describe('cloudflareErrorCode', () => {
	test('reads Workers AI code 971 from a JSON body', () => {
		expect(
			cloudflareErrorCode({
				status: 429,
				body: JSON.stringify({
					success: false,
					errors: [
						{
							code: 971,
							message: 'Please wait and consider throttling your request speed'
						}
					]
				})
			})
		).toBe(971)
	})

	test('reads code 971 from bodyJson', () => {
		expect(
			cloudflareErrorCode({
				bodyJson: {
					errors: [{ code: 971, message: 'throttled' }]
				}
			})
		).toBe(971)
	})
})

describe('rateLimitBackoffMs', () => {
	test('honors Retry-After when present', () => {
		expect(rateLimitBackoffMs({ status: 429 }, 1, 3_000, () => 0)).toBe(3_000)
	})

	test('uses a longer floor for Cloudflare code 971 without Retry-After', () => {
		const error = {
			status: 429,
			body: JSON.stringify({ errors: [{ code: 971, message: 'throttled' }] })
		}
		expect(rateLimitBackoffMs(error, 1, null, () => 0)).toBe(5_000)
		expect(rateLimitBackoffMs(error, 2, null, () => 0)).toBe(10_000)
		expect(rateLimitBackoffMs(error, 3, null, () => 0)).toBe(20_000)
	})

	test('adds jitter above the base wait', () => {
		expect(
			rateLimitBackoffMs({ status: 429 }, 1, 2_000, () => 0.5)
		).toBeGreaterThan(2_000)
	})
})

describe('withCloudflareRateLimitRetry', () => {
	test('retries a 429 after tripping the shared cooldown, then succeeds', async () => {
		let calls = 0
		const run = mock(async () => {
			calls++
			if (calls < 2) {
				throw { status: 429, body: '{"errors":[{"code":971}]}' }
			}
			return 'ok'
		})
		const tripCooldown = mock(async (_waitMs: number) => {})

		await expect(
			withCloudflareRateLimitRetry({
				event: 'workers-ai.to-markdown',
				rateLimitFromError: (error) =>
					typeof error === 'object' &&
					error &&
					'status' in error &&
					error.status === 429
						? { retryAfterMs: null }
						: null,
				tripCooldown,
				run,
				random: () => 0
			})
		).resolves.toBe('ok')

		expect(run).toHaveBeenCalledTimes(2)
		expect(tripCooldown).toHaveBeenCalledTimes(1)
		expect(tripCooldown.mock.calls[0]?.[0]).toBe(5_000)
	})

	test('throws CloudflareRateLimitedError when attempts are exhausted', async () => {
		const run = mock(async () => {
			throw { status: 429, body: '{"errors":[{"code":971}]}' }
		})
		const tripCooldown = mock(async (_waitMs: number) => {})

		const error = await withCloudflareRateLimitRetry({
			event: 'workers-ai.to-markdown',
			maxAttempts: 3,
			rateLimitFromError: () => ({ retryAfterMs: 100 }),
			tripCooldown,
			run,
			random: () => 0,
			now: () => 0
		}).then(
			() => null,
			(err: unknown) => err
		)

		expect(error).toBeInstanceOf(CloudflareRateLimitedError)
		expect(error).toMatchObject({
			attempts: 3,
			event: 'workers-ai.to-markdown'
		})
		expect(run).toHaveBeenCalledTimes(3)
		expect(tripCooldown).toHaveBeenCalledTimes(3)
	})

	test('throws CloudflareRateLimitedError when the wait budget is exhausted', async () => {
		const run = mock(async () => {
			throw { status: 429 }
		})
		const tripCooldown = mock(async (_waitMs: number) => {})

		const error = await withCloudflareRateLimitRetry({
			event: 'workers-ai.to-markdown',
			budgetMs: 1_000,
			rateLimitFromError: () => ({ retryAfterMs: 5_000 }),
			tripCooldown,
			run,
			random: () => 0,
			now: () => 0
		}).then(
			() => null,
			(err: unknown) => err
		)

		expect(error).toBeInstanceOf(CloudflareRateLimitedError)
		expect(error).toMatchObject({ attempts: 1 })
		expect(run).toHaveBeenCalledTimes(1)
		expect(tripCooldown).toHaveBeenCalledTimes(1)
	})

	test('rethrows non-429 errors without tripping cooldown', async () => {
		const run = mock(async () => {
			throw Object.assign(new Error('boom'), { status: 500 })
		})
		const tripCooldown = mock(async (_waitMs: number) => {})

		await expect(
			withCloudflareRateLimitRetry({
				event: 'workers-ai.to-markdown',
				rateLimitFromError: () => null,
				tripCooldown,
				run
			})
		).rejects.toThrow('boom')

		expect(tripCooldown).not.toHaveBeenCalled()
	})
})
