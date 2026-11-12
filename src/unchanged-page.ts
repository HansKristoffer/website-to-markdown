import type { FetchedPage, FetchPageInput } from './fetch-page.js'

/**
 * Whether a full page read without validators is unchanged for a caller that
 * holds these validators, decided the way the origin would have.
 */
export function isUnchangedFor(page: FetchedPage, input: FetchPageInput) {
	return (
		page.outcome === 'ok' &&
		Boolean(
			(input.htmlHash && page.htmlHash === input.htmlHash) ||
			(input.etag && page.etag === input.etag) ||
			(input.lastModified && page.lastModified === input.lastModified)
		)
	)
}

/** `page` as the `unchanged` answer: validators and URLs kept, content dropped. */
export function asUnchanged(page: FetchedPage): FetchedPage {
	return {
		...page,
		outcome: 'unchanged',
		source: 'not-modified',
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
		captureIssue: null,
		htmlHash: null
	}
}
