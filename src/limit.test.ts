import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
	type ConcurrencyLimitOptions,
	createHostLimits,
	URL_TO_MARKDOWN_HOST_LIMIT_CACHE_MAX,
	URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY,
	URL_TO_MARKDOWN_THROTTLED_HOST_MAX_CONCURRENCY
} from './limit.js'
import { createMemoryConcurrencyLimit } from './memory-limit.js'
import { CloudflareRateLimitedError } from './rate-limit-retry.js'

mock.module('./client.js', () => ({
	CloudflareRateLimitedError,
	createCloudflareClient: () => ({
		convertHtmlWithWorkersAi: async () => null,
		convertFileWithWorkersAi: async () => null,
		renderUrlToMarkdown: async () => null
	})
}))

const { createWebsiteToMarkdown } = await import('./fetch-page.js')

const originalFetch = globalThis.fetch

function converter() {
	return createWebsiteToMarkdown({
		cloudflare: { apiToken: 'token', accountId: 'account' },
		isHostAllowed: async () => true
	})
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
	const startedAt = Date.now()
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error('timed out waiting for the fetch layer')
		}
		await Bun.sleep(1)
	}
}

describe('per-host limiters', () => {
	test('a fleet of hostnames shares one metric label and drops evicted limiters', async () => {
		const labels = new Set<string | undefined>()
		let live = 0
		const pool = createHostLimits((options: ConcurrencyLimitOptions) => {
			labels.add(options.metricLabel)
			live++
			const limit = createMemoryConcurrencyLimit(options)
			limit.dispose = () => {
				live--
			}
			return limit
		})

		const hostCount = URL_TO_MARKDOWN_HOST_LIMIT_CACHE_MAX + 88
		for (let index = 0; index < hostCount; index++) {
			expect(
				await pool.withHostLimit(`shop-${index}.example.dk`, async () => 'ok')
			).toBe('ok')
		}

		// One label for every customer host we have ever crawled - a per-host
		// series would be a new time series per customer, forever.
		expect([...labels]).toEqual(['url-to-markdown:host'])
		// Eviction disposes, so the retained limiters stay bounded by the cache
		// rather than by the number of hostnames seen.
		expect(live).toBeLessThanOrEqual(URL_TO_MARKDOWN_HOST_LIMIT_CACHE_MAX)
	})
})

describe('host slot lifetime', () => {
	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	test('holds the slot until the body has been read, not just the headers', async () => {
		const releaseBody: (() => void)[] = []
		let started = 0

		globalThis.fetch = mock(async () => {
			started++
			const delivered = new Promise<void>((resolve) => {
				releaseBody.push(resolve)
			})
			// Headers are ready immediately; the bytes are not. A slot released at
			// the headers would let every caller through at once.
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					await delivered
					controller.enqueue(new TextEncoder().encode('# Kontakt\n\nRing.'))
					controller.close()
				}
			})
			return new Response(body, {
				status: 200,
				headers: { 'content-type': 'text/markdown' }
			})
		}) as unknown as typeof fetch

		const { fetchPageAsMarkdown } = converter()
		// Two more than the cap, whatever the cap is: the assertion is that the
		// surplus waits, not that any particular number does.
		const total = URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY + 2
		const pages = Array.from({ length: total }, (_, index) =>
			fetchPageAsMarkdown({ url: `https://tomrer.dk/side-${index}` })
		)

		await waitUntil(() => started >= URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY)
		// Give the two blocked callers every chance to slip through.
		await Bun.sleep(50)
		expect(started).toBe(URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY)

		// Finishing one body - not one set of headers - is what frees a slot.
		releaseBody[0]?.()
		await waitUntil(() => started >= URL_TO_MARKDOWN_HOST_MAX_CONCURRENCY + 1)

		for (const release of releaseBody) release()
		await waitUntil(() => releaseBody.length === total)
		for (const release of releaseBody) release()

		const results = await Promise.all(pages)
		expect(results.every((page) => page.outcome === 'ok')).toBe(true)
		expect(results[0]?.markdown).toBe('# Kontakt\n\nRing.')
	})

	test('an origin that refuses bursts is read in full once the host narrows', async () => {
		// Shopify's shape: anything past two requests in flight is refused, with
		// no pause asked for.
		let inFlight = 0
		globalThis.fetch = mock(async () => {
			inFlight++
			try {
				await Bun.sleep(10)
				if (inFlight > URL_TO_MARKDOWN_THROTTLED_HOST_MAX_CONCURRENCY)
					return new Response('slow down', {
						status: 429,
						headers: { 'retry-after': '0' }
					})
				return new Response('# Produkt\n\n195 kr.', {
					status: 200,
					headers: { 'content-type': 'text/markdown' }
				})
			} finally {
				inFlight--
			}
		}) as unknown as typeof fetch

		const { fetchPageAsMarkdown } = converter()
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				fetchPageAsMarkdown({ url: `https://shop.dk/products/${index}` })
			)
		)

		expect(results.map((page) => page.outcome)).toEqual(Array(6).fill('ok'))
	})
})

describe('rate-limited host', () => {
	test('is read two at a time after its pause, and other hosts are not', async () => {
		const pool = createHostLimits()
		const startedAt = Date.now()
		const starts: number[] = []
		let active = 0
		let peak = 0
		const read = async () => {
			starts.push(Date.now() - startedAt)
			active++
			peak = Math.max(peak, active)
			await Bun.sleep(20)
			active--
		}

		await pool.coolDownHost('shop.dk', 300)
		const other = pool.withHostLimit(
			'other.dk',
			async () => Date.now() - startedAt
		)
		await Promise.all(
			Array.from({ length: 4 }, () => pool.withHostLimit('shop.dk', read))
		)

		expect(peak).toBe(URL_TO_MARKDOWN_THROTTLED_HOST_MAX_CONCURRENCY)
		expect(Math.min(...starts)).toBeGreaterThanOrEqual(250)
		expect(await other).toBeLessThan(250)
	})
})
