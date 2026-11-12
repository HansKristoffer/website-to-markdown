import { expect, test } from 'bun:test'
import { fakePage, fakeSite } from './index.js'

test('fakePage is a complete ok page for the URL', () => {
	const page = fakePage({ url: 'https://a.dk/', markdown: '# A' })
	expect(page).toMatchObject({
		url: 'https://a.dk/',
		finalUrl: 'https://a.dk/',
		outcome: 'ok',
		markdown: '# A',
		alternates: [],
		captureIssue: null
	})
})

test('fakeSite answers known pages, 404s the rest and honours validators', async () => {
	const site = fakeSite({
		'https://a.dk': {
			markdown: '# A',
			links: ['https://a.dk/kontakt'],
			etag: 'v1'
		}
	})

	const first = await site.fetchPageAsMarkdown({ url: 'https://a.dk' })
	const again = await site.fetchPageAsMarkdown({
		url: 'https://a.dk',
		etag: 'v1'
	})
	const missing = await site.fetchPageAsMarkdown({ url: 'https://a.dk/x' })

	expect(first.links).toEqual(['https://a.dk/kontakt'])
	expect(again).toMatchObject({
		outcome: 'unchanged',
		status: 304,
		markdown: ''
	})
	expect(missing).toMatchObject({ outcome: 'gone', status: 404 })
	expect(site.calls.map((call) => call.url)).toEqual([
		'https://a.dk',
		'https://a.dk',
		'https://a.dk/x'
	])
})
