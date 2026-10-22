import {
	getUniqueValues,
	isOneOf,
	normalizeWhitespace,
	safeJsonParse
} from 'hanzio'
import { decodeHtmlEntities } from './html-entities.js'

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i
const HTML_LANG_RE = /<html\b[^>]*?\blang\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i
const LINK_TAG_RE = /<link\b[^>]*>/gi
const META_TAG_RE = /<meta\b[^>]*>/gi
const JSON_LD_RE =
	/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
const ATTRIBUTE_RE = /([a-z_:][-a-z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const HTML_TAG_RE = /<[^>]*>/g

function unquote(value: string) {
	const first = value[0]
	if ((first === '"' || first === "'") && value.endsWith(first)) {
		return value.slice(1, -1)
	}
	return value
}

function attributesOf(tag: string) {
	const attributes: Record<string, string> = {}
	for (const match of tag.matchAll(ATTRIBUTE_RE)) {
		const name = match[1]?.toLowerCase()
		const value = match[2]
		if (!name || value === undefined) continue
		attributes[name] = decodeHtmlEntities(unquote(value))
	}
	return attributes
}

function cleanText(value: string) {
	return normalizeWhitespace(
		decodeHtmlEntities(value.replace(HTML_TAG_RE, ' '))
	)
}

function absolute(url: string, baseUrl: string) {
	try {
		const resolved = new URL(url, baseUrl)
		if (!isOneOf(['https:', 'http:'], resolved.protocol)) return null
		return resolved.href
	} catch {
		return null
	}
}

function parseJsonLd(html: string) {
	const blocks: unknown[] = []
	for (const match of html.matchAll(JSON_LD_RE)) {
		const body = match[1]?.trim()
		if (!body) continue
		const parsed = safeJsonParse(body)
		// Hand-written JSON-LD with a trailing comma is common; skip the block.
		if (!parsed.ok) continue
		// A single script may hold an array of nodes; flatten so the profile
		// layer can look for `@type` without walking two shapes.
		if (Array.isArray(parsed.data)) blocks.push(...parsed.data)
		else blocks.push(parsed.data)
	}
	return blocks
}

/**
 * Everything the pipeline needs from the HTML that markdown cannot carry.
 * Regex-level on purpose: we read five fields plus JSON-LD out of pages that
 * are often invalid HTML, and a parser would cost more than it buys.
 */
export function extractHtmlMetadata(html: string, baseUrl: string) {
	const title = cleanText(TITLE_RE.exec(html)?.[1] ?? '') || null

	const langRaw = HTML_LANG_RE.exec(html)?.[1]
	const langCode = langRaw ? unquote(langRaw).trim().split(/[-_]/)[0] : null
	// ISO 639-1 only: `da-DK` → `da`, and a bogus `lang="Dansk"` becomes null.
	const lang =
		langCode && /^[a-z]{2}$/i.test(langCode) ? langCode.toLowerCase() : null

	let canonical: string | null = null
	// `<link rel="alternate" hreflang>`: the site's own declaration of which
	// URLs are translations of this page. `x-default` is a language picker,
	// not a translation.
	const alternates: string[] = []
	/** Each alternate's language (`da` of `da-DK`); what lets a crawl skip a mirror. */
	const alternateLanguages: Record<string, string> = {}
	for (const match of html.matchAll(LINK_TAG_RE)) {
		const attributes = attributesOf(match[0])
		// `rel` is a token list: WordPress emits `rel="shortlink canonical"`.
		const rel = attributes.rel?.toLowerCase().split(/\s+/) ?? []
		if (!attributes.href) continue
		if (rel.includes('canonical') && !canonical) {
			canonical = absolute(attributes.href, baseUrl)
		}
		const hreflang = attributes.hreflang?.trim().toLowerCase()
		if (rel.includes('alternate') && hreflang && hreflang !== 'x-default') {
			const href = absolute(attributes.href, baseUrl)
			const language = hreflang.split('-')[0] ?? ''
			if (href) alternates.push(href)
			if (href && /^[a-z]{2}$/.test(language))
				alternateLanguages[href] = language
		}
	}

	let metaDescription: string | null = null
	let ogDescription: string | null = null
	for (const match of html.matchAll(META_TAG_RE)) {
		const attributes = attributesOf(match[0])
		const key = (attributes.name ?? attributes.property ?? '').toLowerCase()
		const content = attributes.content?.trim()
		if (!content) continue
		if (key === 'description') metaDescription ??= cleanText(content)
		if (key === 'og:description') ogDescription ??= cleanText(content)
	}

	return {
		title,
		lang,
		canonical,
		alternates: getUniqueValues(alternates),
		alternateLanguages,
		metaDescription: metaDescription || ogDescription || null,
		jsonLd: parseJsonLd(html)
	}
}
