import { getUniqueValues, isOneOf, trimTrailingSlash } from 'hanzio'
import { isAllowedByRobots, parseRobotsTxt } from 'hanzio/sitemap'
import { throughCrawlSnapshot } from '../crawl-snapshot.js'
import { type Fetch, guardedFetch } from '../net-guard.js'
import { decodeText, readBody } from '../read-body.js'
import { BROWSER_USER_AGENT } from '../user-agent.js'

export type { Fetch }

const FETCH_TIMEOUT_MS = 10_000
const MAX_SITEMAP_FILES = 20
const MAX_URLS = 20_000
/** Google reads the first 500 KiB of a robots.txt and ignores the rest. */
const MAX_ROBOTS_BYTES = 500 * 1024
/**
 * Read cap per sitemap file. 20,000 URLs fit in a few MB; a longer file is
 * read up to here and its complete entries used.
 */
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024

export type SitemapOptions = {
	/**
	 * The `fetch` robots.txt and sitemaps go through. Default
	 * {@link guardedFetch} with the default guard (public addresses only, every
	 * redirect checked); pass `converter.guardedFetch` to use the converter's.
	 */
	fetch?: Fetch | undefined
}

/** Conventional sitemap locations, tried in order when robots.txt names none. */
const SITEMAP_ROOT_PATHS = [
	'/sitemap.xml',
	'/sitemap_index.xml',
	'/wp-sitemap.xml'
]

const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/gi
const URL_ENTRY_RE = /<url>([\s\S]*?)<\/url>/gi
const SITEMAP_ENTRY_RE = /<sitemap>([\s\S]*?)<\/sitemap>/gi
const ENTRY_LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/i
const LASTMOD_RE = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i
const ROBOTS_SITEMAP_RE = /^[^\S\r\n]*sitemap[^\S\r\n]*:[^\S\r\n]*(\S+)/gim

const XML_ENTITIES = new Map([
	['&amp;', '&'],
	['&lt;', '<'],
	['&gt;', '>'],
	['&quot;', '"'],
	['&apos;', "'"],
	['&#39;', "'"]
])

/** One pass, so `&amp;lt;` decodes to `&lt;` and not to `<`. */
function decodeXmlEntities(value: string) {
	return value.replace(
		/&(?:amp|lt|gt|quot|apos|#39);/g,
		(entity) => XML_ENTITIES.get(entity) ?? entity
	)
}

/** Parses one sitemap document into page entries and nested sitemap URLs. */
export function parseSitemapXml(xml: string) {
	const pages: { url: string; lastmod: string | null }[] = []
	const nested: string[] = []

	for (const match of xml.matchAll(URL_ENTRY_RE)) {
		const entry = match[1] ?? ''
		const loc = entry.match(ENTRY_LOC_RE)?.[1]
		if (!loc) continue
		pages.push({
			url: decodeXmlEntities(loc),
			lastmod: entry.match(LASTMOD_RE)?.[1]?.trim() ?? null
		})
	}
	for (const match of xml.matchAll(SITEMAP_ENTRY_RE)) {
		const loc = match[1]?.match(ENTRY_LOC_RE)?.[1]
		if (loc) nested.push(decodeXmlEntities(loc))
	}
	// Plain `<loc>` lists without `<url>` wrappers (rare, but seen in the wild).
	if (pages.length === 0 && nested.length === 0) {
		for (const match of xml.matchAll(LOC_RE)) {
			if (match[1])
				pages.push({ url: decodeXmlEntities(match[1]), lastmod: null })
		}
	}
	return { pages, nested }
}

type TextRequest = { accept: string; maxBytes: number; fetch: Fetch }

function fetchText(url: string, request: TextRequest) {
	return throughCrawlSnapshot(`text ${request.accept} ${url}`, () =>
		fetchTextLive(url, request)
	)
}

async function fetchTextLive(url: string, request: TextRequest) {
	try {
		const response = await request.fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: request.accept, 'user-agent': BROWSER_USER_AGENT }
		})
		const type = response.headers.get('content-type') ?? ''
		// A CMS that renders its 404 page for a missing file answers 200 with HTML.
		if (!response.ok || type.includes('text/html')) {
			void response.body?.cancel().catch(() => {})
			return null
		}
		return decodeText((await readBody(response, request.maxBytes)).bytes)
	} catch {
		return null
	}
}

const ROBOTS_REQUEST = {
	accept: 'text/plain,*/*;q=0.8',
	maxBytes: MAX_ROBOTS_BYTES
}
const SITEMAP_REQUEST = {
	accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
	maxBytes: MAX_SITEMAP_BYTES
}

function originOf(websiteUrl: string) {
	try {
		return new URL(websiteUrl).origin
	} catch {
		return null
	}
}

/**
 * `/robots.txt`, read once: its `Sitemap:` lines, absolute-ised (many CMSs
 * publish their sitemap somewhere other than `/sitemap.xml` and only say so
 * here), and its rules. An HTML body or any non-200 means "no robots.txt";
 * never throws.
 */
export async function fetchRobots(
	websiteUrl: string,
	options: SitemapOptions = {}
) {
	const sitemaps: string[] = []
	const origin = originOf(websiteUrl)
	if (!origin) return { sitemaps, rules: [] }
	const robotsUrl = `${origin}/robots.txt`
	const body = await fetchText(robotsUrl, {
		...ROBOTS_REQUEST,
		fetch: options.fetch ?? guardedFetch
	})
	if (!body) return { sitemaps, rules: [] }

	for (const match of body.matchAll(ROBOTS_SITEMAP_RE)) {
		const value = match[1]
		if (!value) continue
		try {
			const absolute = new URL(value, robotsUrl)
			// Only what we could actually GET - `ftp:` and friends are noise.
			if (!isOneOf(['http:', 'https:'], absolute.protocol)) continue
			sitemaps.push(absolute.toString())
		} catch {
			// A malformed Sitemap: line must not cost us the other lines.
		}
	}
	return {
		sitemaps: getUniqueValues(sitemaps),
		rules: parseRobotsRules(body)
	}
}

export type RobotsRule = { allow: boolean; pattern: string }

/**
 * The `Allow`/`Disallow` lines of the `User-agent: *` groups. We read pages
 * with a browser user agent, so a group naming a specific crawler is not ours;
 * the wildcard group is what the site asks of everyone. An empty `Disallow:`
 * allows everything and adds no rule.
 */
export function parseRobotsRules(body: string): RobotsRule[] {
	const { allow, disallow } = parseRobotsTxt(body)
	return [
		...allow.map((pattern) => ({ allow: true, pattern })),
		...disallow.map((pattern) => ({ allow: false, pattern }))
	]
}

/**
 * Whether robots.txt lets us read this URL: the longest matching rule wins and
 * `Allow` wins a tie, as Google reads it. Shopify disallows `/cart/`, and the
 * crawler had fetched `/cart/add?id=…&quantity=1` - a GET that fills a cart.
 */
export function robotsAllows(rules: RobotsRule[], url: string) {
	return isAllowedByRobots(
		{
			allow: rules.filter((rule) => rule.allow).map((rule) => rule.pattern),
			disallow: rules.filter((rule) => !rule.allow).map((rule) => rule.pattern)
		},
		url
	)
}

/**
 * Reads a set of sitemap roots (following index nesting) into `found`.
 * Returns true when at least one of them yielded page URLs, so the caller can
 * stop trying further roots.
 */
async function readSitemapTree(
	roots: string[],
	found: Map<string, { url: string; lastmod: string | null }>,
	seen: Set<string>,
	fetch: Fetch
) {
	let readable = false
	let level = [...roots]

	// One level of the index at a time, its files read side by side: a shop
	// with a sitemap per locale and type read up to 20 files one after another,
	// on the path to the first page read. Results are applied in listed order,
	// so which copy of a URL is kept does not depend on network timing.
	while (level.length > 0 && found.size < MAX_URLS) {
		const batch: string[] = []
		for (const sitemapUrl of level) {
			if (seen.has(sitemapUrl) || seen.size >= MAX_SITEMAP_FILES) continue
			seen.add(sitemapUrl)
			batch.push(sitemapUrl)
		}
		const bodies = await Promise.all(
			batch.map((sitemapUrl) =>
				fetchText(sitemapUrl, { ...SITEMAP_REQUEST, fetch })
			)
		)
		const next: string[] = []
		for (const xml of bodies) {
			if (!xml) continue
			const { pages, nested } = parseSitemapXml(xml)
			// An empty document is not a sitemap we can use - let the next root try.
			if (pages.length === 0 && nested.length === 0) continue
			if (pages.length > 0) readable = true
			next.push(...nested)
			for (const page of pages) {
				if (found.size >= MAX_URLS) break
				// Keyed on the normalised form so `/kontakt` and `/kontakt/` listed in
				// two sitemap files do not become two fetches.
				const key = normalizeSitemapUrl(page.url)
				if (!found.has(key)) found.set(key, page)
			}
		}
		level = next
	}
	return readable
}

/**
 * Every URL the site's sitemaps list, robots-declared sitemaps (`fetchRobots`)
 * first and the conventional roots as a fallback. Returns `[]` when the site has no usable
 * sitemap - a fifth of real customer sites have none, which is normal and not
 * an error: link-following discovery is the source, sitemaps a supplement.
 * Never throws.
 */
export async function discoverSitemapUrls(
	websiteUrl: string,
	robotsSitemaps: string[],
	options: SitemapOptions = {}
) {
	const origin = originOf(websiteUrl)
	if (!origin) return []
	const fetch = options.fetch ?? guardedFetch
	const found = new Map<string, { url: string; lastmod: string | null }>()
	// Shared across roots so a broken sitemap index cannot spend the file budget
	// several times over.
	const seen = new Set<string>()

	// robots.txt may declare several sitemaps (WordPress splits per post type),
	// so all of them are read together - only the conventional roots compete.
	if (
		robotsSitemaps.length > 0 &&
		(await readSitemapTree(robotsSitemaps, found, seen, fetch))
	) {
		return [...found.values()]
	}
	for (const path of SITEMAP_ROOT_PATHS) {
		if (await readSitemapTree([`${origin}${path}`], found, seen, fetch)) break
	}
	return [...found.values()]
}

/** One key per page whatever the trailing slash or fragment. */
export function normalizeSitemapUrl(url: string) {
	try {
		const parsed = new URL(url)
		parsed.hash = ''
		return trimTrailingSlash(parsed.toString())
	} catch {
		return trimTrailingSlash(url)
	}
}
