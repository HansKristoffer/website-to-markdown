import {
	type ElementOf,
	exponentialBackoff,
	fileExtension,
	getUniqueValues,
	invariant,
	isOneOf,
	isRecord,
	must,
	type Nullable,
	parseRetryAfter,
	startTimer,
	timeoutSignal,
	typedSwitch,
	typedSwitchGroup
} from 'hanzio'
import type { ApiError } from 'hanzio/api-wrapper'
import {
	type CloudflareCredentials,
	CloudflareRateLimitedError,
	createCloudflareClient
} from './client.js'
import { classifyContentType, convertibleDocumentType } from './content-type.js'
import {
	type CrawlSnapshotInput,
	type CrawlSnapshotOptions,
	currentCrawlSnapshot,
	throughCrawlSnapshot,
	withCrawlSnapshot
} from './crawl-snapshot.js'
import {
	isApplicationShell,
	isBlankMarkdown,
	looksLikeHtml
} from './detect-markdown.js'
import { sha256Hex } from './hash.js'
import { extractHtmlMetadata } from './html-metadata.js'
import { type CreateConcurrencyLimit, createHostLimits } from './limit.js'
import { errorLogAttributes, type Logger, silentLogger } from './logger.js'
import {
	htmlImages,
	htmlLinks,
	markdownRefs,
	stripDocumentPreamble,
	stripFrontMatter,
	titleFromMarkdown
} from './markdown-refs.js'
import { createMemoryConcurrencyLimit } from './memory-limit.js'
import { isHostAllowed, isLocalhostHostname } from './net-guard.js'
import { currentOperationSignal } from './operation-signal.js'
import { BROWSER_USER_AGENT } from './user-agent.js'
import { preserveXlsxZeros } from './xlsx-zeros.js'

const FETCH_TIMEOUT_MS = 30_000
/** Browser Rendering once returned a 6 MB markdown page from a 6 MB upload. */
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const MAX_PDF_BYTES = 12 * 1024 * 1024
const MAX_PDF_PAGES = 60

/** Stored markdown ceiling; a page over this is a listing or an upload, not knowledge. */
export const MAX_MARKDOWN_CHARS = 300_000

export type FetchOutcome =
	'ok' | 'unchanged' | 'gone' | 'blocked' | 'transient' | 'unsupported'
export type FetchSource =
	| 'content-negotiation'
	| 'workers-ai'
	| 'browser-rendering'
	| 'not-modified'
	| 'firecrawl-parse'

export type FetchedPage = {
	/** The URL we requested, after http->https upgrade and www fallback. */
	url: string
	/** After redirects; may differ in host or path. */
	finalUrl: string
	/** HTTP status of the origin response, or 0 when the request never completed. */
	status: number
	outcome: FetchOutcome
	source: FetchSource | null
	contentType: string | null
	etag: string | null
	lastModified: string | null
	/** Empty string unless outcome === 'ok'. Front-matter stripped, capped. */
	markdown: string
	/** <title> when an HTML tier read the page, else the first markdown H1. */
	title: string | null
	/** ISO 639-1 from <html lang>, lowercased, else null. */
	lang: string | null
	/** <link rel="canonical">, absolute. */
	canonical: string | null
	/** `<link rel="alternate" hreflang>` targets, absolute, `x-default` excluded. Optional: many callers build a page from parts. */
	alternates?: string[]
	/** `alternates` by language: URL -> ISO 639-1 (`da` of `da-DK`). */
	alternateLanguages?: Record<string, string>
	/** <meta name="description"> or the og: equivalent. */
	metaDescription: string | null
	/** Parsed application/ld+json blocks (any shape; the profile layer reads LocalBusiness/OpeningHoursSpecification). */
	jsonLd: unknown[]
	/**
	 * Absolute, deduped link targets: the markdown's, unioned with every
	 * `<a href>` when an HTML tier read the page. Conversion loses navigation,
	 * and a link lost here is a page discovery can never reach.
	 */
	links: string[]
	/** Absolute, deduped image URLs found in the markdown. */
	images: string[]
	durationMs: number
	captureIssue?: Nullable<string>
	/**
	 * Hash of the HTML the origin served, when an origin tier read HTML. Given
	 * back on the next read (`fetchPageAsMarkdown({ htmlHash })`), identical HTML
	 * is answered as `unchanged` without converting it again.
	 */
	htmlHash?: Nullable<string>
}

type PageBase = {
	url: string
	finalUrl: string
	status: number
	contentType: string | null
	etag: string | null
	lastModified: string | null
	elapsedMs: () => number
}

export type PageBody = {
	captureIssue?: Nullable<string>
	outcome: FetchOutcome
	source: FetchSource | null
	markdown?: Nullable<string>
	/** The HTML an origin tier read, when one did - the only source of metadata. */
	html?: Nullable<string>
}

/**
 * The one place markdown, front-matter and HTML metadata are reconciled: the
 * HTML `<title>` wins, the Workers AI front-matter is the fallback for pages we
 * only ever saw as markdown, and links/images are resolved against `finalUrl`.
 */
function buildPage(
	base: PageBase,
	rawBody: PageBody,
	logger: Logger
): FetchedPage {
	// A NUL byte is never text, and Postgres refuses a string that holds one:
	// a single page with one (a Wix site's conversion) failed the whole import.
	// Composed Unicode, because every comparison downstream assumes it: a site
	// that wrote "Gård" as "a" plus a combining ring gave the fact guard the
	// name "Broges Ga", which no draft could contain, and the document shipped
	// as its verbatim source.
	const clean = (text: Nullable<string>) =>
		text?.replaceAll('\u0000', '').normalize('NFC')
	const body = {
		...rawBody,
		markdown: clean(rawBody.markdown),
		html: clean(rawBody.html)
	}
	const frontMatter = stripFrontMatter(body.markdown ?? '')
	let markdown = frontMatter.markdown
	if (markdown.length > MAX_MARKDOWN_CHARS) {
		logger.warn('url-to-markdown.truncated', {
			url: base.finalUrl,
			chars: markdown.length
		})
		markdown = markdown.slice(0, MAX_MARKDOWN_CHARS)
	}

	const metadata = body.html
		? extractHtmlMetadata(body.html, base.finalUrl)
		: null
	const refs = markdownRefs(markdown, base.finalUrl)
	// The markdown is the document; the HTML is the map. Conversion drops
	// navigation (image-wrapped anchors, folded menus), so when we hold the
	// HTML its anchors decide what discovery can still reach.
	const links = body.html
		? getUniqueValues([...refs.links, ...htmlLinks(body.html, base.finalUrl)])
		: refs.links

	return {
		url: base.url,
		finalUrl: base.finalUrl,
		status: base.status,
		outcome: body.outcome,
		source: body.source,
		contentType: base.contentType,
		etag: base.etag,
		lastModified: base.lastModified,
		markdown,
		title: metadata?.title ?? frontMatter.title ?? titleFromMarkdown(markdown),
		lang: metadata?.lang ?? null,
		canonical: metadata?.canonical ?? null,
		alternates: metadata?.alternates ?? [],
		alternateLanguages: metadata?.alternateLanguages ?? {},
		metaDescription:
			metadata?.metaDescription ?? frontMatter.description ?? null,
		jsonLd: metadata?.jsonLd ?? [],
		links,
		images: getUniqueValues([
			...refs.images,
			...(body.html ? htmlImages(body.html, base.finalUrl) : [])
		]),
		captureIssue:
			frontMatter.markdown.length > MAX_MARKDOWN_CHARS
				? 'markdown_limit'
				: (body.captureIssue ?? null),
		durationMs: Math.round(base.elapsedMs()),
		htmlHash: body.html ? htmlHash(body.html) : null
	}
}

/**
 * `http://` is upgraded rather than rejected: two carpenter sites in the probe
 * link internally with `http://` and the https-only guard threw away most of
 * their pages. Localhost http stays reachable outside production.
 */
function prepareRequestUrl(raw: string) {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		return null
	}
	if (parsed.protocol === 'https:') return parsed
	if (parsed.protocol !== 'http:') return null
	if (isLocalhostHostname(parsed.hostname)) {
		return process.env.NODE_ENV === 'production' ? null : parsed
	}
	parsed.protocol = 'https:'
	if (parsed.port === '80') parsed.port = ''
	return parsed
}

/**
 * `apoteket.dk` answers no TLS handshake at the apex while `www.apoteket.dk`
 * serves the whole site, so a connection failure gets one www retry.
 */
function wwwFallbackUrl(url: URL) {
	const host = url.hostname
	if (host.startsWith('www.') || !host.includes('.')) return null
	if (isLocalhostHostname(host) || /^[\d.]+$/.test(host)) return null
	const next = new URL(url.href)
	next.hostname = `www.${host}`
	return next
}

/**
 * A 429 is an origin asking us to slow down, not a bot wall. Shopify answered
 * 117 of Good Habit's 244 reads with it; sent on to Browser Rendering they
 * tripped Cloudflare's own limit (79 times, 25-30 s each) and 7 came back.
 * So the host is narrowed and paused (`coolDownHost`), the URL is asked again,
 * and a page still refused after that is `transient`: its stored copy stands
 * and the next run reads it.
 */
const MAX_RATE_LIMIT_RETRIES = 3
const MAX_RATE_LIMIT_WAIT_MS = 30_000

/** The origin's `Retry-After` when it sent one, else 1 s, 2 s, 4 s. */
function rateLimitWaitMs(response: Response, retry: number) {
	const askedMs = parseRetryAfter(response.headers.get('retry-after'))
	return Math.min(
		MAX_RATE_LIMIT_WAIT_MS,
		askedMs ??
			exponentialBackoff(retry, {
				baseMs: 1_000,
				maxMs: MAX_RATE_LIMIT_WAIT_MS,
				jitter: false
			})
	)
}

/**
 * Bump whenever conversion changes what the same HTML becomes (`withoutHiddenUi`,
 * the Workers AI call, the fallback tiers): the stored hash then no longer
 * matches, and every page is converted again once instead of keeping the
 * markdown the old conversion made.
 */
const CONVERSION_VERSION = 1

function htmlHash(html: string) {
	return sha256Hex(`${CONVERSION_VERSION}\n${html}`)
}

/** The request URL with the market pinned; the URL itself when there is none. */
function inMarket(url: URL, country: Nullable<string>) {
	if (!country || url.searchParams.has('country')) return url
	const pinned = new URL(url.href)
	pinned.searchParams.set('country', country)
	return pinned
}

/** `Response.url` is empty on a synthesised response and after some proxies. */
function parseFinalUrl(responseUrl: string, requestUrl: URL) {
	if (!responseUrl) return requestUrl
	try {
		return new URL(responseUrl)
	} catch {
		return requestUrl
	}
}

function isAbortError(error: unknown) {
	return isRecord(error) && isOneOf(['AbortError', 'TimeoutError'], error.name)
}

/** The content kinds whose body is read as text; the rest are documents or assets. */
const TEXTUAL_KINDS = ['markdown', 'html', 'text'] as const
type TextualKind = ElementOf<typeof TEXTUAL_KINDS>

/** What the origin gave us, already downloaded under the host's politeness slot. */
type OriginBody =
	| { kind: 'none'; captureIssue?: string }
	| { kind: 'text'; text: string }
	| { kind: 'bytes'; bytes: ArrayBuffer }

type OriginRead = { response: Response; finalUrl: URL; body: OriginBody }

type OriginAttempt =
	| { kind: 'read'; read: OriginRead }
	| { kind: 'refused' }
	| { kind: 'failed'; retryable: boolean }

/** Reading the body is optional; an unsupported type is dropped at the headers. */
function discardBody(response: Response) {
	void response.body?.cancel().catch(() => {})
}

/**
 * Decides from the headers alone whether the body is worth downloading, and
 * downloads it when it is. Everything downstream works from bytes already in
 * hand, so nothing past this point needs the origin's slot.
 */
async function readOriginBody(
	response: Response,
	finalUrl: URL,
	logger: Logger
): Promise<OriginBody> {
	const status = response.status
	if (status < 200 || status >= 300) {
		discardBody(response)
		return { kind: 'none' }
	}

	const contentType = response.headers.get('content-type')
	const kind = classifyContentType(contentType)
	return typedSwitch(kind, {
		asset: () => {
			discardBody(response)
			return { kind: 'none' }
		},
		document: async () => {
			const type = convertibleDocumentType(contentType)
			if (!type) {
				discardBody(response)
				return { kind: 'none' }
			}
			const limit =
				type.extension === 'pdf' ? MAX_PDF_BYTES : MAX_DOCUMENT_BYTES
			const declared = Number(response.headers.get('content-length'))
			if (Number.isFinite(declared) && declared > limit) {
				discardBody(response)
				logger.info('url-to-markdown.document_oversized', {
					url: finalUrl.href,
					bytes: declared
				})
				return { kind: 'none', captureIssue: 'document_byte_limit' }
			}
			const bytes = await readBoundedBody(response, limit)
			return bytes
				? { kind: 'bytes', bytes }
				: { kind: 'none', captureIssue: 'document_byte_limit' }
		},
		...typedSwitchGroup(kind, TEXTUAL_KINDS, async (): Promise<OriginBody> => ({
			kind: 'text',
			text: await response.text()
		}))
	})
}

function documentFilename(finalUrl: string, extension: string) {
	const segment = finalUrl.split(/[?#]/)[0]?.split('/').pop() || 'document'
	const name = segment.slice(0, 80)
	return fileExtension(name) === extension ? name : `${name}.${extension}`
}

/** Streaming limits bound chunked bodies as well as declared Content-Length. */
async function readBoundedBody(
	response: Response,
	maxBytes: number
): Promise<ArrayBuffer | null> {
	const reader = response.body?.getReader()
	if (!reader) return new ArrayBuffer(0)
	const chunks: Uint8Array[] = []
	let size = 0
	while (true) {
		const next = await reader.read()
		if (next.done) break
		size += next.value.byteLength
		if (size > maxBytes) {
			await reader.cancel()
			return null
		}
		chunks.push(next.value)
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes.buffer
}

/**
 * Markup a visitor never sees until they open it: `<template>` content and
 * closed `<dialog>`s. A Shopify theme ships its cart drawer ("Your cart is
 * empty") and search overlay (a product list with prices) in every page this
 * way; converted, they reached 70 of one store's 89 pages and a price table
 * in seven of its documents (Good Habit audit §3.4). An open dialog is shown
 * and stays. A contact or newsletter form (Shopify posts both to `/contact`)
 * is labels and a button, and "Telefon Kommentar Send us a note" read as the
 * name `Kommentar Send` the fact guard then demanded of the document.
 *
 * Plus the form fields a visitor cannot see: an anti-spam honeypot inside a
 * `display:none` block renamed its label ("Navn" / "Url") on every request,
 * so a carpenter's seven pages hashed as changed and five documents were
 * rewritten every night. Only labels go - a collapsed FAQ answer is hidden the
 * same way and must stay.
 */
const HIDDEN_UI_SELECTOR = [
	'template',
	'dialog:not([open])',
	'form[action*="/contact"]',
	'[style*="display:none"] label',
	'[style*="display: none"] label'
].join(', ')

function withoutHiddenUi(html: string) {
	return new HTMLRewriter()
		.on(HIDDEN_UI_SELECTOR, {
			element(element) {
				element.remove()
			}
		})
		.transform(html)
}

/** A real browser passes these; every other 4xx has nothing for it to find. */
const BOT_WALL_STATUSES = [401, 403] as const

export type FetchPageInput = {
	url: string
	/** Stored validators from the last run; a 304 returns outcome 'unchanged'. */
	etag?: Nullable<string>
	lastModified?: Nullable<string>
	/** Allow the Browser Rendering tier. Default true. */
	render?: boolean | undefined
	/**
	 * ISO country of the market to read the page in. A Shopify store redirects
	 * by the visitor's IP - our worker reads a Danish shop as its EU market in
	 * euros and English (Good Habit audit §3.2) - and `?country=DK` pins it.
	 * Applied to the request only: the page keeps the URL it was asked for.
	 */
	country?: Nullable<string>
	/** The last read's `htmlHash`; identical HTML comes back `unchanged`. */
	htmlHash?: Nullable<string>
	signal?: AbortSignal | undefined
}

export type PdfParser = (input: {
	bytes: ArrayBuffer
	filename: string
	mimeType: string
	/** Pages to read at most; a parse that reaches it is marked incomplete. */
	maxPages: number
	signal?: AbortSignal | undefined
}) => Promise<{ markdown: string; numPages: number | null }>

export type WebsiteToMarkdownOptions = {
	/** Workers AI and Browser Rendering; read on first use, so getters work. */
	cloudflare: CloudflareCredentials
	/**
	 * Builds every pool: the two Cloudflare ones and one per origin host.
	 * Defaults to an in-memory limiter; pass a shared one (Redis) when several
	 * processes share the Cloudflare quota.
	 */
	createLimit?: CreateConcurrencyLimit
	/** Workers AI client errors other than 429s, for an error tracker. */
	onApiError?: (error: ApiError) => void
	/**
	 * Pass Workers AI timeouts to `onApiError`. A timed-out page falls through
	 * to the next tier, so `false` keeps import bursts out of error tracking.
	 * Default true.
	 */
	reportTimeouts?: boolean
	logger?: Logger
	/**
	 * Where the returned `withCrawlSnapshot` keeps snapshots. Its logger
	 * defaults to `logger`.
	 */
	crawlSnapshot?: CrawlSnapshotOptions
	/** The OCR tier for a PDF Workers AI returned nothing for. */
	parsePdf?: PdfParser
	/**
	 * SSRF guard run before every origin request. Defaults to
	 * {@link isHostAllowed}: public addresses only, localhost outside production.
	 */
	isHostAllowed?: (hostname: string) => Promise<boolean>
}

/**
 * One converter: its Cloudflare client, pools and per-host politeness limits.
 * Create it once per process; every call shares the pools.
 */
export function createWebsiteToMarkdown(options: WebsiteToMarkdownOptions) {
	const logger = options.logger ?? silentLogger
	const createLimit = options.createLimit ?? createMemoryConcurrencyLimit
	const client = createCloudflareClient({
		credentials: options.cloudflare,
		createLimit,
		onApiError: options.onApiError,
		reportTimeouts: options.reportTimeouts,
		logger
	})
	const hostLimits = createHostLimits(createLimit)
	const allowHost =
		options.isHostAllowed ??
		((hostname: string) => isHostAllowed(hostname, logger))

	async function requestOrigin(
		url: URL,
		headers: Record<string, string>,
		signal?: AbortSignal | undefined
	): Promise<OriginAttempt> {
		if (signal?.aborted) return { kind: 'failed', retryable: false }
		if (!(await allowHost(url.hostname))) {
			return { kind: 'refused' }
		}
		try {
			// The politeness slot spans the connection *and* the body: freed at the
			// response headers it would bound connections only, and the whole 80-wide
			// page pool could still be streaming from one small WordPress host at
			// once - the burst the cap exists to prevent, at any cap we would pick.
			// The Cloudflare tiers stay outside it - they are
			// our upstreams with their own pools, and holding a customer's slot
			// across a 60s render would stall the crawl for no politeness gain.
			const read = await hostLimits.withHostLimit(url.hostname, async () => {
				const response = await fetch(url, {
					redirect: 'follow',
					signal: timeoutSignal(FETCH_TIMEOUT_MS, signal),
					headers
				})
				const finalUrl = parseFinalUrl(response.url, url)
				return {
					response,
					finalUrl,
					body: await readOriginBody(response, finalUrl, logger)
				}
			})
			return { kind: 'read', read }
		} catch (error) {
			logger.warn('url-to-markdown.origin_failed', {
				url: url.href,
				...errorLogAttributes(error)
			})
			// A body that dies mid-stream is the same class of failure as a refused
			// connection, and the same www retry is worth a try.
			return { kind: 'failed', retryable: !isAbortError(error) }
		}
	}

	/**
	 * Bytes of a document to markdown: Workers AI `toMarkdown` first, the
	 * `parsePdf` tier (e.g. Firecrawl: text-first, OCR fallback) for a PDF Workers
	 * AI returned nothing for. Shared by the crawler (a linked terms PDF) and file
	 * uploads (the same PDF dropped in by hand), so both read a file the same
	 * way. `workersAiMaxBytes` is the caller's budget: the crawler keeps it at
	 * {@link MAX_DOCUMENT_BYTES}; an upload of a 50 MB scanned catalogue may go
	 * straight to the OCR tier.
	 */
	async function convertDocumentBytes(input: {
		bytes: ArrayBuffer
		filename: string
		mimeType: string
		extension: string
		workersAiMaxBytes?: number | undefined
		signal?: AbortSignal | undefined
	}): Promise<PageBody> {
		const { bytes } = input
		if (!bytes.byteLength) return { outcome: 'unsupported', source: null }
		if (input.signal?.aborted) return { outcome: 'transient', source: null }
		let workersAiRateLimited = false
		let markdown: string | null = null
		if (bytes.byteLength <= (input.workersAiMaxBytes ?? MAX_DOCUMENT_BYTES)) {
			try {
				markdown = await client.convertFileWithWorkersAi({
					body: input.extension === 'xlsx' ? preserveXlsxZeros(bytes) : bytes,
					filename: input.filename,
					mimeType: input.mimeType,
					signal: input.signal
				})
			} catch (error) {
				if (!(error instanceof CloudflareRateLimitedError)) throw error
				workersAiRateLimited = true
			}
		}
		const body = stripDocumentPreamble(markdown ?? '')
		if (!isBlankMarkdown(body))
			return { outcome: 'ok', source: 'workers-ai', markdown: body }
		if (input.extension !== 'pdf') {
			return {
				outcome: 'transient',
				source: null,
				captureIssue: workersAiRateLimited ? 'workers_ai_rate_limited' : null
			}
		}
		if (input.signal?.aborted) return { outcome: 'transient', source: null }
		try {
			const parsePdf = must(options.parsePdf, 'No PDF parser configured')
			const parsed = await parsePdf({
				bytes,
				filename: input.filename,
				mimeType: input.mimeType,
				maxPages: MAX_PDF_PAGES,
				signal: input.signal
			})
			return {
				outcome: 'ok',
				source: 'firecrawl-parse',
				markdown: parsed.markdown,
				// The parser may report parsed pages rather than total pages; reaching the
				// limit is therefore explicitly incomplete even when the count equals it.
				captureIssue:
					parsed.numPages === null || parsed.numPages >= MAX_PDF_PAGES
						? 'pdf_page_limit_unverified'
						: null
			}
		} catch (error) {
			logger.warn('url-to-markdown.pdf_parse_failed', {
				filename: input.filename,
				...errorLogAttributes(error)
			})
			return {
				outcome: 'transient',
				source: null,
				captureIssue: workersAiRateLimited
					? 'workers_ai_rate_limited'
					: 'pdf_extraction_failed'
			}
		}
	}

	async function convertDocument(input: {
		body: OriginBody
		contentType: string | null
		finalUrl: URL
		signal?: AbortSignal | undefined
	}): Promise<PageBody> {
		const type = convertibleDocumentType(input.contentType)
		if (!type || input.body.kind !== 'bytes') {
			return {
				outcome: 'unsupported',
				source: null,
				captureIssue: typedSwitch(input.body, 'kind', {
					none: (body) => body.captureIssue,
					text: () => null,
					bytes: () => null
				})
			}
		}
		return convertDocumentBytes({
			bytes: input.body.bytes,
			filename: documentFilename(input.finalUrl.href, type.extension),
			mimeType: type.mimeType,
			extension: type.extension,
			signal: input.signal
		})
	}

	async function convertTextual(input: {
		text: string
		kind: TextualKind
		finalUrl: URL
		render: boolean
		/** The hash of the HTML last read; see `FetchedPage.htmlHash`. */
		htmlHash?: Nullable<string>
		signal?: AbortSignal | undefined
	}): Promise<PageBody> {
		const body = input.text
		// The `Content-Type` header is authoritative - sniffing for a leading
		// `<html` misses every page that opens with a comment or a CDN banner - but
		// a `text/plain` body that is plainly HTML still needs the HTML tier.
		const isHtml = typedSwitch(input.kind, {
			html: () => true,
			markdown: () => false,
			text: () => looksLikeHtml(body)
		})

		if (!isHtml && !isBlankMarkdown(body)) {
			return { outcome: 'ok', source: 'content-negotiation', markdown: body }
		}

		const html = isHtml ? body : null
		// Most origins send no validators, so without this every page of a quiet
		// site went through Workers AI again every night to learn nothing moved.
		if (html && input.htmlHash && htmlHash(html) === input.htmlHash) {
			return { outcome: 'unchanged', source: 'not-modified' }
		}
		if (html && Buffer.byteLength(html) > MAX_HTML_BYTES) {
			// A 6 MB HTML upload came back as 6 MB of markdown through Browser
			// Rendering, and Workers AI would bill the same bytes. It is not a page,
			// and it will be just as oversized next run - so not `transient`.
			logger.info('url-to-markdown.html_oversized', {
				url: input.finalUrl.href,
				bytes: Buffer.byteLength(html)
			})
			return { outcome: 'unsupported', source: null, html }
		}

		let shell = false
		let workersAiRateLimited = false
		if (html) {
			const visible = withoutHiddenUi(html)
			let converted: string | null = null
			try {
				converted = await client.convertHtmlWithWorkersAi({
					html: visible,
					// The post-redirect host: Cloudflare resolves relative links against it.
					hostname: input.finalUrl.hostname,
					signal: input.signal
				})
			} catch (error) {
				if (!(error instanceof CloudflareRateLimitedError)) throw error
				workersAiRateLimited = true
			}
			if (converted && !isBlankMarkdown(converted)) {
				shell = isApplicationShell(visible, converted)
				if (!shell)
					return {
						outcome: 'ok',
						source: 'workers-ai',
						markdown: converted,
						html
					}
			}
		}

		// Browser Rendering is the exception path: slow, rate limited, and the only
		// tier that ever timed out in the probe.
		if (input.render && !input.signal?.aborted) {
			let rendered: string | null = null
			try {
				rendered = await client.renderUrlToMarkdown(
					input.finalUrl.href,
					input.signal
				)
			} catch (error) {
				if (!(error instanceof CloudflareRateLimitedError)) throw error
				workersAiRateLimited = true
			}
			if (
				rendered &&
				!isBlankMarkdown(rendered) &&
				(!html || !isApplicationShell(html, rendered))
			) {
				return {
					outcome: 'ok',
					source: 'browser-rendering',
					markdown: rendered,
					html
				}
			}
		}
		return {
			outcome: 'transient',
			source: null,
			html,
			captureIssue: shell
				? 'render_incomplete'
				: workersAiRateLimited
					? 'workers_ai_rate_limited'
					: null
		}
	}

	/** Runs after the origin's slot is released: every tier it reaches is ours. */
	async function readResponse(
		input: OriginRead & {
			render: boolean
			htmlHash?: Nullable<string>
			signal?: AbortSignal | undefined
		}
	): Promise<PageBody> {
		const { response, body } = input
		const status = response.status
		const contentType = response.headers.get('content-type')

		if (status === 304) return { outcome: 'unchanged', source: 'not-modified' }
		if (isOneOf([404, 410], status)) {
			return { outcome: 'gone', source: null }
		}
		// Still refused after the host's pauses: rendering would only be refused
		// too (see `MAX_RATE_LIMIT_RETRIES`).
		if (status >= 500 || status === 429)
			return { outcome: 'transient', source: null }
		if (status >= 400) {
			if (!input.render || !isOneOf(BOT_WALL_STATUSES, status)) {
				return { outcome: 'blocked', source: null }
			}
			const rendered = await client.renderUrlToMarkdown(
				input.finalUrl.href,
				input.signal
			)
			return rendered
				? { outcome: 'ok', source: 'browser-rendering', markdown: rendered }
				: { outcome: 'blocked', source: null }
		}
		if (status < 200 || status >= 300) {
			return { outcome: 'transient', source: null }
		}

		const kind = classifyContentType(contentType)
		return typedSwitch(kind, {
			asset: () => ({ outcome: 'unsupported', source: null }),
			document: () =>
				convertDocument({
					body,
					contentType,
					finalUrl: input.finalUrl,
					signal: input.signal
				}),
			...typedSwitchGroup(
				kind,
				TEXTUAL_KINDS,
				async (textualKind): Promise<PageBody> =>
					body.kind === 'text'
						? convertTextual({
								text: body.text,
								kind: textualKind,
								finalUrl: input.finalUrl,
								render: input.render,
								htmlHash: input.htmlHash,
								signal: input.signal
							})
						: { outcome: 'unsupported', source: null }
			)
		})
	}

	/**
	 * Read one URL as markdown through Cloudflare's three tiers - content
	 * negotiation, Workers AI `toMarkdown`, Browser Rendering - and report
	 * everything the import pipeline needs about the page: real status, redirect
	 * target, validators, HTML metadata and absolute links.
	 *
	 * Never throws: a page that cannot be read is an outcome, not an exception,
	 * because the caller is crawling hundreds of URLs at a time. A knowledge bench
	 * run reads through its crawl snapshot (`crawl-snapshot.ts`).
	 */
	async function fetchPageAsMarkdown(
		input: FetchPageInput
	): Promise<FetchedPage> {
		if (!currentCrawlSnapshot()) return fetchPageLive(input)

		// The snapshot holds the whole page, read without validators; whether it is
		// "unchanged" for this run is decided here, the way the origin would.
		const page = await throughCrawlSnapshot(
			`page ${input.url} ${input.country ?? ''} ${input.render ?? true}`,
			() =>
				fetchPageLive({
					url: input.url,
					country: input.country,
					render: input.render,
					signal: input.signal
				})
		)
		const unchanged =
			page.outcome === 'ok' &&
			((input.htmlHash && page.htmlHash === input.htmlHash) ||
				(input.etag && page.etag === input.etag))
		if (!unchanged) return page

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

	async function fetchPageLive(input: FetchPageInput): Promise<FetchedPage> {
		const signal = input.signal ?? currentOperationSignal()
		const elapsedMs = startTimer()
		const render = input.render ?? true

		const prepared = prepareRequestUrl(input.url)
		if (!prepared) {
			return buildPage(
				{
					url: input.url,
					finalUrl: input.url,
					status: 0,
					contentType: null,
					etag: null,
					lastModified: null,
					elapsedMs
				},
				{ outcome: 'unsupported', source: null },
				logger
			)
		}

		const headers: Record<string, string> = {
			Accept: 'text/markdown, text/html;q=0.9, */*;q=0.8',
			'Accept-Language': '*',
			'User-Agent': BROWSER_USER_AGENT
		}
		if (input.etag) headers['If-None-Match'] = input.etag
		if (input.lastModified) headers['If-Modified-Since'] = input.lastModified

		const request = (url: URL) =>
			requestOrigin(inMarket(url, input.country), headers, signal)

		let requestUrl = prepared
		let attempt: OriginAttempt = await request(requestUrl)

		if (attempt.kind === 'failed' && attempt.retryable) {
			const fallback = wwwFallbackUrl(requestUrl)
			if (fallback) {
				const retry = await request(fallback)
				if (retry.kind === 'read') {
					requestUrl = fallback
					attempt = retry
				}
			}
		}

		for (
			let retry = 1;
			retry <= MAX_RATE_LIMIT_RETRIES &&
			attempt.kind === 'read' &&
			attempt.read.response.status === 429;
			retry++
		) {
			const waitMs = rateLimitWaitMs(attempt.read.response, retry)
			if (await hostLimits.coolDownHost(requestUrl.hostname, waitMs)) {
				logger.warn('url-to-markdown.host_rate_limited', {
					host: requestUrl.hostname,
					retry_after: attempt.read.response.headers.get('retry-after') ?? '',
					wait_ms: waitMs
				})
			}
			attempt = await request(requestUrl)
		}

		if (attempt.kind !== 'read') {
			return buildPage(
				{
					url: requestUrl.href,
					finalUrl: requestUrl.href,
					status: 0,
					contentType: null,
					etag: null,
					lastModified: null,
					elapsedMs
				},
				{
					outcome: typedSwitch(attempt, 'kind', {
						// A refused host is a policy decision, not a retryable network blip.
						refused: () => 'blocked',
						failed: () => 'transient'
					}),
					source: null
				},
				logger
			)
		}

		const { response, finalUrl } = attempt.read
		const notModified = (stored: Nullable<string>) =>
			response.status === 304 ? (stored ?? null) : null
		const body = await readResponse({
			...attempt.read,
			render,
			htmlHash: input.htmlHash,
			signal
		})

		const page = buildPage(
			{
				url: requestUrl.href,
				finalUrl: finalUrl.href,
				status: response.status,
				contentType: response.headers.get('content-type'),
				// A 304 need not repeat the validators; the stored ones stay valid. On
				// any other status only this response's headers count - carrying an old
				// ETag onto changed content would freeze the page forever.
				etag: response.headers.get('etag') ?? notModified(input.etag),
				lastModified:
					response.headers.get('last-modified') ??
					notModified(input.lastModified),
				elapsedMs
			},
			body,
			logger
		)

		logger.info('url-to-markdown.completed', {
			url: page.finalUrl,
			status: page.status,
			outcome: page.outcome,
			source: page.source ?? '',
			chars: page.markdown.length,
			duration_ms: page.durationMs
		})
		return page
	}

	/** CLI/one-shot shape: markdown or an error. */
	async function urlToMarkdown(urlString: string) {
		const page = await fetchPageAsMarkdown({ url: urlString })
		const { markdown, source } = page
		if (page.outcome !== 'ok' || !markdown || !source) {
			throw new Error(
				`Failed to convert URL to markdown (${page.outcome}, status ${page.status}): ${urlString}`
			)
		}
		return { markdown, source }
	}

	return {
		fetchPageAsMarkdown,
		convertDocumentBytes,
		urlToMarkdown,
		convertFileWithWorkersAi: client.convertFileWithWorkersAi,
		renderUrlToMarkdown: client.renderUrlToMarkdown,
		/** The SSRF guard the converter runs, bound to its `logger`. */
		isHostAllowed: allowHost,
		/** `withCrawlSnapshot` bound to the `crawlSnapshot` option. */
		withCrawlSnapshot<T>(
			input: Nullable<CrawlSnapshotInput>,
			run: () => Promise<T>
		) {
			if (!input) return run()
			invariant(
				options.crawlSnapshot,
				'Set crawlSnapshot.root to use crawl snapshots'
			)
			return withCrawlSnapshot(input, run, {
				root: options.crawlSnapshot.root,
				logger: options.crawlSnapshot.logger ?? logger
			})
		}
	}
}

export type WebsiteToMarkdown = ReturnType<typeof createWebsiteToMarkdown>
