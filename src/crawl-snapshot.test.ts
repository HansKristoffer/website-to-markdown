import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type CrawlSnapshotInput,
	throughCrawlSnapshot,
	withCrawlSnapshot as withSnapshotUnder
} from './crawl-snapshot.js'
import { createWebsiteToMarkdown } from './fetch-page.js'
import { sha256Hex } from './hash.js'
import { fakePage } from './testing/index.js'

const name = `unit-test-${process.pid}/example.test`
const root = await mkdtemp(join(tmpdir(), 'crawl-snapshot-'))
const { fetchPageAsMarkdown } = createWebsiteToMarkdown({
	cloudflare: { apiToken: 'token', accountId: 'account' }
})

function withCrawlSnapshot<T>(
	input: CrawlSnapshotInput,
	run: () => Promise<T>
) {
	return withSnapshotUnder(input, run, { root })
}

afterAll(() => rm(root, { recursive: true, force: true }))

describe('crawl snapshot', () => {
	test('a replay returns what was recorded without reading again', async () => {
		const record = mock(async () => 'robots v1')
		await withCrawlSnapshot({ mode: 'record', name }, () =>
			throughCrawlSnapshot('text robots', record)
		)

		const replay = mock(async () => 'robots v2')
		const replayed = await withCrawlSnapshot({ mode: 'replay', name }, () =>
			throughCrawlSnapshot('text robots', replay)
		)

		expect(replayed).toBe('robots v1')
		expect(replay).not.toHaveBeenCalled()
	})

	test('a read the recording never made goes to the network and is kept', async () => {
		const read = mock(async () => 'new page')
		const run = () =>
			withCrawlSnapshot({ mode: 'replay', name }, () =>
				throughCrawlSnapshot('text unseen', read)
			)

		expect(await run()).toBe('new page')
		expect(await run()).toBe('new page')
		expect(read).toHaveBeenCalledTimes(1)
	})

	test('a page whose stored HTML matches the last run replays as unchanged', async () => {
		const page = fakePage({
			url: 'https://example.test/',
			markdown: '# Hello',
			title: 'Hello',
			lastModified: 'Tue, 03 Nov 2026 08:00:00 GMT',
			htmlHash: 'hash-1'
		})
		await withCrawlSnapshot({ mode: 'record', name }, () =>
			throughCrawlSnapshot('page https://example.test/  true', async () => page)
		)

		const replay = (input: { htmlHash?: string; lastModified?: string }) =>
			withCrawlSnapshot({ mode: 'replay', name }, () =>
				fetchPageAsMarkdown({ url: 'https://example.test/', ...input })
			)

		expect((await replay({})).markdown).toBe('# Hello')
		expect((await replay({ htmlHash: 'hash-1' })).outcome).toBe('unchanged')
		expect((await replay({ htmlHash: 'hash-0' })).outcome).toBe('ok')
		expect(
			(await replay({ lastModified: 'Tue, 03 Nov 2026 08:00:00 GMT' })).outcome
		).toBe('unchanged')
	})

	test('a stored file cut short is a miss, not a crash', async () => {
		const key = 'text truncated'
		const directory = join(root, name)
		await mkdir(directory, { recursive: true })
		await writeFile(
			join(directory, `${sha256Hex(key).slice(0, 32)}.json`),
			'{"key":"text trunc'
		)
		const replayed = await withCrawlSnapshot({ mode: 'replay', name }, () =>
			throughCrawlSnapshot(key, async () => 'live again')
		)
		expect(replayed).toBe('live again')
	})

	test('a name that would leave the snapshot directory is refused', () => {
		expect(() =>
			withCrawlSnapshot({ mode: 'record', name: '../../etc/passwd' }, () =>
				Promise.resolve()
			)
		).toThrow()
	})
})

describe('createWebsiteToMarkdown crawlSnapshot', () => {
	test('the bound withCrawlSnapshot records under root and logs misses', async () => {
		const warn = mock(() => {})
		const converter = createWebsiteToMarkdown({
			cloudflare: { apiToken: 'token', accountId: 'account' },
			logger: { info() {}, warn },
			crawlSnapshot: { root }
		})
		const bound = `bound-${process.pid}/example.test`
		const read = mock(async () => 'live')

		await converter.withCrawlSnapshot({ mode: 'replay', name: bound }, () =>
			throughCrawlSnapshot('text bound', read)
		)
		const replayed = await withCrawlSnapshot(
			{ mode: 'replay', name: bound },
			() => throughCrawlSnapshot('text bound', async () => 'again')
		)

		expect(replayed).toBe('live')
		expect(warn).toHaveBeenCalledWith('crawl-snapshot.miss', {
			key: 'text bound'
		})
	})

	test('without crawlSnapshot it runs plain jobs and refuses snapshots', async () => {
		expect(await runWithoutSnapshotRoot(null)).toBe('ran')
		expect(() => runWithoutSnapshotRoot({ mode: 'record', name })).toThrow(
			'crawlSnapshot.root'
		)
	})
})

function runWithoutSnapshotRoot(input: CrawlSnapshotInput | null) {
	return createWebsiteToMarkdown({
		cloudflare: { apiToken: 'token', accountId: 'account' }
	}).withCrawlSnapshot(input, async () => 'ran')
}
