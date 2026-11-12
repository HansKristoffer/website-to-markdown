import type { FetchedPage, FetchPageInput } from '../fetch-page.js'
import { asUnchanged, isUnchangedFor } from '../unchanged-page.js'

/** A complete `FetchedPage`: an `ok` HTML read of `url` with nothing on it, plus `page`. */
export function fakePage(
	page: Partial<FetchedPage> & { url: string }
): FetchedPage {
	return {
		finalUrl: page.url,
		status: 200,
		outcome: 'ok',
		source: 'workers-ai',
		contentType: 'text/html; charset=utf-8',
		etag: null,
		lastModified: null,
		markdown: '',
		title: null,
		lang: null,
		canonical: null,
		alternates: [],
		alternateLanguages: {},
		metaDescription: null,
		jsonLd: [],
		links: [],
		images: [],
		durationMs: 0,
		captureIssue: null,
		htmlHash: null,
		...page
	}
}

/**
 * A site in memory with the converter's `fetchPageAsMarkdown`: the pages
 * given by URL, `gone` (404) for any other, `unchanged` (304) when the input's
 * `etag`, `lastModified` or `htmlHash` matches the page's. `calls` lists every
 * input in order.
 */
export function fakeSite(
	pages: Record<string, Omit<Partial<FetchedPage>, 'url'>>
) {
	const calls: FetchPageInput[] = []
	async function fetchPageAsMarkdown(input: FetchPageInput) {
		calls.push(input)
		const known = pages[input.url]
		if (!known) {
			return fakePage({
				url: input.url,
				status: 404,
				outcome: 'gone',
				source: null
			})
		}
		const page = fakePage({ ...known, url: input.url })
		return isUnchangedFor(page, input)
			? { ...asUnchanged(page), status: 304 }
			: page
	}
	return { fetchPageAsMarkdown, calls }
}
