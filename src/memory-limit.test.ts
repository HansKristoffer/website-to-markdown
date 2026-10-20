import { describe, expect, test } from 'bun:test'
import { createMemoryConcurrencyLimit } from './memory-limit.js'

describe('createMemoryConcurrencyLimit', () => {
	test('holds the cap and the start rate, and a waiter can be aborted', async () => {
		const limit = createMemoryConcurrencyLimit({
			key: 'test',
			max: 2,
			maxStartsPerSecond: 3,
			slotTtlMs: 1_000
		})
		const startedAt = Date.now()
		const starts: number[] = []
		let active = 0
		let peak = 0
		const run = async () => {
			starts.push(Date.now() - startedAt)
			peak = Math.max(peak, ++active)
			await Bun.sleep(10)
			active--
		}

		const controller = new AbortController()
		const runs = Array.from({ length: 4 }, () => limit(run))
		const aborted = limit(run, controller.signal).catch((error) => error)
		controller.abort()

		await Promise.all(runs)
		expect(await aborted).toMatchObject({ name: 'AbortError' })
		expect(peak).toBe(2)
		// The fourth start waits for the first to leave the one-second window.
		expect(starts[3]).toBeGreaterThanOrEqual(950)
	})

	test('a tripped cooldown delays the next start', async () => {
		const limit = createMemoryConcurrencyLimit({
			key: 'test',
			max: 5,
			slotTtlMs: 1_000
		})
		const startedAt = Date.now()
		await limit.tripCooldown(100)
		expect(
			await limit(async () => Date.now() - startedAt)
		).toBeGreaterThanOrEqual(95)
	})
})
