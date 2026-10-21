import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sha256Hex } from './hash.js'
import type { Logger } from './logger.js'
import {
	CRAWL_SNAPSHOT_NAME_PATTERN,
	type CrawlSnapshotInput
} from './schema/index.js'

export { CRAWL_SNAPSHOT_NAME_PATTERN, type CrawlSnapshotInput }

/**
 * A crawl recorded once and replayed, for benchmarks. Two runs of a pipeline
 * then read the same pages, so a difference between them is the code: not a
 * site that published a page in between, a 429, or a host that timed out on
 * one run and not the other.
 *
 * Recorded: the network reads - pages as `fetchPageAsMarkdown` returns them,
 * robots.txt and sitemaps - plus anything the caller routes through
 * `throughCrawlSnapshot`. Everything else runs live on every replay, which is
 * the point.
 *
 * Set per job through `withCrawlSnapshot`, never globally: a worker drains
 * other tenants' jobs on the same lane. Never in production.
 */

type CrawlSnapshot = CrawlSnapshotInput & {
	directory: string
	logger: Logger | undefined
}

export type CrawlSnapshotOptions = {
	/** Directory the snapshots live under. */
	root: string
	/** Told about replay misses. */
	logger?: Logger | undefined
}

const snapshot = new AsyncLocalStorage<CrawlSnapshot>()

export function withCrawlSnapshot<T>(
	input: CrawlSnapshotInput | null | undefined,
	run: () => Promise<T>,
	options: CrawlSnapshotOptions
) {
	if (!input) return run()
	if (process.env.NODE_ENV === 'production') {
		throw new Error('A crawl snapshot is a local bench tool')
	}
	if (!CRAWL_SNAPSHOT_NAME_PATTERN.test(input.name)) {
		throw new Error(`Invalid crawl snapshot name: ${input.name}`)
	}

	return snapshot.run(
		{
			mode: input.mode,
			name: input.name,
			directory: resolve(options.root, input.name),
			logger: options.logger
		},
		run
	)
}

/**
 * `read` through the active snapshot. Recording stores what the network
 * returned; replaying returns what was stored. A read the recording never made
 * (a code change that discovers a new URL) goes to the network and is added,
 * with a warning, so the snapshot stays complete without hiding the drift.
 */
export async function throughCrawlSnapshot<T>(
	key: string,
	read: () => Promise<T>
): Promise<T> {
	const active = snapshot.getStore()
	if (!active) return read()

	const file = resolve(active.directory, `${sha256Hex(key).slice(0, 32)}.json`)
	if (active.mode === 'replay') {
		const stored = await readFile(file, 'utf8').catch(() => null)
		if (stored !== null) return (JSON.parse(stored) as { value: T }).value
		active.logger?.warn('crawl-snapshot.miss', { key })
	}

	const value = await read()
	await mkdir(active.directory, { recursive: true })
	await writeFile(file, JSON.stringify({ key, value }))
	return value
}

/** The snapshot this job reads or writes, to hand on to the job it queues. */
export function currentCrawlSnapshot(): CrawlSnapshotInput | null {
	const active = snapshot.getStore()
	return active ? { mode: active.mode, name: active.name } : null
}
