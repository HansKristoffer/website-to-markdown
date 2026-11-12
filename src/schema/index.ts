/**
 * Values a shared schema can import without the runtime: no Node built-ins,
 * no peer libraries.
 */

/** A crawl snapshot name, `<snapshot>/<host>`; it becomes a path, so it may not climb out of the root. */
export const CRAWL_SNAPSHOT_NAME_PATTERN =
	/^[a-z0-9._-]{1,80}\/[a-z0-9._-]{1,120}$/

export type CrawlSnapshotInput = {
	mode: 'record' | 'replay'
	/** `<snapshot>/<host>`: the bench's snapshot label, then the site. */
	name: string
}

/** Every `FetchedPage.outcome`, for narrowing a value read back from storage. */
export const FETCH_OUTCOMES = [
	'ok',
	'unchanged',
	'gone',
	'blocked',
	'transient',
	'unsupported'
] as const
export type FetchOutcome = (typeof FETCH_OUTCOMES)[number]

/** Every `FetchedPage.source`. `firecrawl-parse` is the `parsePdf` tier, whatever parser it is. */
export const FETCH_SOURCES = [
	'content-negotiation',
	'workers-ai',
	'browser-rendering',
	'not-modified',
	'firecrawl-parse'
] as const
export type FetchSource = (typeof FETCH_SOURCES)[number]

/** Every `FetchedPage.captureIssue`: why a page came back incomplete or not at all. */
export const CAPTURE_ISSUES = [
	'markdown_limit',
	'html_byte_limit',
	'document_byte_limit',
	'workers_ai_rate_limited',
	'browser_rendering_rate_limited',
	'render_incomplete',
	'pdf_page_limit_unverified',
	'pdf_extraction_failed'
] as const
export type CaptureIssue = (typeof CAPTURE_ISSUES)[number]
