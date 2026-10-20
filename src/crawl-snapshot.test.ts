import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type CrawlSnapshotInput,
	throughCrawlSnapshot,
	withCrawlSnapshot as withSnapshotUnder
} from './crawl-snapshot.js'
import { createWebsiteToMarkdown } from './fetch-page.js'

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
		const page = {
			url: 'https://example.test/',
			finalUrl: 'https://example.test/',
			status: 200,
			outcome: 'ok',
			source: 'workers-ai',
			contentType: 'text/html',
			etag: null,
			lastModified: null,
			markdown: '# Hello',
			title: 'Hello',
			lang: 'da',
			canonical: null,
			metaDescription: null,
			jsonLd: [],
			links: [],
			images: [],
			durationMs: 1,
			htmlHash: 'hash-1'
		}
		await withCrawlSnapshot({ mode: 'record', name }, () =>
			throughCrawlSnapshot('page https://example.test/  true', async () => page)
		)

		const replay = (htmlHash: string | null) =>
			withCrawlSnapshot({ mode: 'replay', name }, () =>
				fetchPageAsMarkdown({ url: 'https://example.test/', htmlHash })
			)

		expect((await replay(null)).markdown).toBe('# Hello')
		expect((await replay('hash-1')).outcome).toBe('unchanged')
		expect((await replay('hash-0')).outcome).toBe('ok')
	})

	test('a name that would leave the snapshot directory is refused', () => {
		expect(() =>
			withCrawlSnapshot({ mode: 'record', name: '../../etc/passwd' }, () =>
				Promise.resolve()
			)
		).toThrow()
	})
})
