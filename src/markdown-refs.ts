import { compact, getUniqueValues, isOneOf } from 'hanzio'
import { decodeHtmlEntities } from './html-entities.js'

/**
 * Workers AI `toMarkdown` prefixes every conversion with a YAML block:
 * `---\ntitle: …\ndescription: …\n---`. It is a conversion artefact, not page
 * content, so it never reaches a document - but its two fields are the best
 * fallback we have for pages whose HTML we never saw.
 */
const FRONT_MATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function frontMatterValue(block: string, key: string) {
	const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'im').exec(block)
	const raw = line?.[1]?.trim()
	if (!raw) return null
	const unquoted = /^(["'])([\s\S]*)\1$/.exec(raw)?.[2] ?? raw
	return unquoted.trim() || null
}

export function stripFrontMatter(markdown: string) {
	const match = FRONT_MATTER_RE.exec(markdown)
	if (!match) return { markdown, title: null, description: null }
	const block = match[1] ?? ''
	return {
		markdown: markdown.slice(match[0].length).replace(/^\s+/, ''),
		title: frontMatterValue(block, 'title'),
		description: frontMatterValue(block, 'description')
	}
}

/**
 * Workers AI `toMarkdown` opens every converted PDF and office file with the
 * file name as an H1, a `## Metadata` list (creation dates, uuids,
 * `PDFFormatVersion=1.7`) and a `## Contents` heading, then labels every page
 * `### Page N`. None of it is what the document says: a hotel's terms PDF
 * came back as 13,000 characters with its creation dates and uuids inside,
 * and a reader of the markdown takes those for facts of the document.
 */
const DOCUMENT_TITLE_RE =
	/^#\s+[^\n]*\.(?:pdf|docx?|xlsx?|pptx?|odt|rtf)\s*\r?\n/i
const DOCUMENT_METADATA_RE =
	/^##\s+Metadata\s*\r?\n(?:(?:-\s[^\n]*|\s*)\r?\n)*/i
const DOCUMENT_CONTENTS_RE = /^##\s+Contents\s*\r?\n/i
const DOCUMENT_PAGE_HEADING_RE = /^#{1,6}\s+Page\s+\d+\s*$/gim

export function stripDocumentPreamble(markdown: string): string {
	let text = markdown.replace(/^\s+/, '')
	const beforeTitle = text
	text = text.replace(DOCUMENT_TITLE_RE, '').replace(/^\s+/, '')
	text = text.replace(DOCUMENT_METADATA_RE, '').replace(/^\s+/, '')
	text = text.replace(DOCUMENT_CONTENTS_RE, '').replace(/^\s+/, '')
	// A file that carried none of the preamble is a plain conversion; the page
	// labels are still Workers AI's, so they go regardless.
	if (text === beforeTitle && !DOCUMENT_PAGE_HEADING_RE.test(text)) {
		return markdown
	}
	return text
		.replace(DOCUMENT_PAGE_HEADING_RE, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/**
 * Cloudflare's e-mail obfuscation rewrites every address it finds into
 * `[\[email protected\]](/cdn-cgi/l/email-protection#<hex>)`, so a converted
 * page behind it shows no readable address at all. The hex is the address
 * XOR-ed with its first byte; decoded only when the result is shaped like an
 * address.
 */
const CF_EMAIL_LINK_RE =
	/\[(?:[^[\]\\]|\\.|\[[^\]]*\])*\]\((?:https?:\/\/[^/)]+)?\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]{8,})\)/g

function decodeCloudflareEmail(hex: string) {
	const key = Number.parseInt(hex.slice(0, 2), 16)
	let address = ''
	for (let index = 2; index + 1 < hex.length; index += 2) {
		address += String.fromCharCode(
			Number.parseInt(hex.slice(index, index + 2), 16) ^ key
		)
	}
	return /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(address) ? address : null
}

/**
 * `<script type="application/ld+json">` survives conversion as a fenced code
 * block on Yoast and Squarespace sites. It is never prose, and the page already
 * carries it parsed as `jsonLd`.
 */
const FENCED_BLOCK_RE = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm
const JSON_LD_RE = /schema\.org|["']@context["']\s*:/

/** A page that inlines an SVG file gets its prolog back from the converter as text. */
const MARKUP_DECLARATION_RE = /<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/gi

/**
 * A label rendered next to its own value with no space between -
 * `[Saleshello@example.com](mailto:hello@example.com)`,
 * `[Support+45 22 81 82 95](tel:+4522818295)` - reads as an invented address.
 * Matched on the value's shape, so the label's language never matters.
 */
const VALUE_LINK_RE = /\[([^\]]+)\]\((mailto|tel):([^)\s]+)\)/gi

function emailStart(label: string, target: string) {
	const address = (target.split('?')[0] ?? '').toLowerCase()
	return address && label.toLowerCase().endsWith(address)
		? label.length - address.length
		: -1
}

function phoneStart(label: string, target: string) {
	const digits = target.replace(/\D/g, '')
	if (digits.length < 6) return -1
	const first = label.search(/[+\d]/)
	if (first < 0) return -1
	const rest = label.slice(first)
	return /^[+\d\s().-]+$/.test(rest) && rest.replace(/\D/g, '') === digits
		? first
		: -1
}

/**
 * Removes what Cloudflare's conversion leaves behind and is never page text:
 * obfuscated e-mail links are decoded, JSON-LD code fences and markup
 * declarations dropped, and labels glued to their `mailto:`/`tel:` value
 * split. Applied to every fetched page; idempotent, so markdown stored by an
 * older version can be run through it too.
 */
export function cleanConvertedMarkdown(markdown: string) {
	return markdown
		.replace(CF_EMAIL_LINK_RE, (link, hex: string) => {
			const address = decodeCloudflareEmail(hex)
			return address ? `[${address}](mailto:${address})` : link
		})
		.replace(FENCED_BLOCK_RE, (block, body: string) =>
			JSON_LD_RE.test(body) ? '' : block
		)
		.replace(MARKUP_DECLARATION_RE, '')
		.replace(
			VALUE_LINK_RE,
			(link, label: string, scheme: string, target: string) => {
				const start =
					scheme.toLowerCase() === 'mailto'
						? emailStart(label, target)
						: phoneStart(label, target)
				if (start <= 0 || !/\p{L}/u.test(label[start - 1] ?? '')) return link
				return `[${label.slice(0, start)} ${label.slice(start)}](${scheme}:${target})`
			}
		)
}

export function titleFromMarkdown(markdown: string) {
	const heading = markdown.match(/^#\s+(.+)$/m)
	return heading?.[1]?.trim() || null
}

const TITLE_PART = `(?:\\s+(?:"[^"]*"|'[^']*'|\\([^)]*\\)))?`
const TARGET_PART = `\\(\\s*(<[^>]*>|[^()\\s]+)${TITLE_PART}\\s*\\)`

/** `![alt](url "title")`. Scanned separately so `[![logo](img)](/)` yields both. */
const IMAGE_RE = new RegExp(
	`!\\[(?:[^\\[\\]\\\\]|\\\\.)*\\]${TARGET_PART}`,
	'g'
)
/** `[text](url)`; the leading `!` marks an image and is skipped. */
const LINK_RE = new RegExp(
	`(!?)\\[(?:[^\\[\\]\\\\]|\\\\.|\\[[^\\]]*\\])*\\]${TARGET_PART}`,
	'g'
)
const AUTOLINK_RE = /<(https?:\/\/[^\s<>]+)>/gi

function resolveTarget(target: string, baseUrl: string) {
	const raw = decodeHtmlEntities(
		target.startsWith('<') && target.endsWith('>')
			? target.slice(1, -1).trim()
			: target.trim()
	)
	// Pure fragments point at the page we already have.
	if (!raw || raw.startsWith('#')) return null
	try {
		const resolved = new URL(raw, baseUrl)
		// Drops `mailto:`, `tel:`, `javascript:`, `data:` and every other scheme
		// discovery cannot crawl; they stay in the markdown itself.
		if (!isOneOf(['https:', 'http:'], resolved.protocol)) return null
		// Cloudflare's reserved prefix is plumbing, never a page: the e-mail
		// obfuscation endpoint under it answers 410, which used to count as a
		// page this site failed to deliver. `cleanConvertedMarkdown` has already
		// decoded the address out of the link.
		if (resolved.pathname.startsWith('/cdn-cgi/')) return null
		return resolved.href
	} catch {
		return null
	}
}

/** Resolved targets, deduped, in the order they were found. */
function resolveUnique(targets: (string | undefined)[], baseUrl: string) {
	return getUniqueValues(
		compact(
			targets.map((target) => (target ? resolveTarget(target, baseUrl) : null))
		)
	)
}

/**
 * Absolute, deduped, document-order links and images. Discovery crawls these,
 * so relative targets (`/kontakt`) and CMS-escaped query strings
 * (`?image=x&amp;width=200`) have to come out resolved and decoded.
 */
export function markdownRefs(markdown: string, baseUrl: string) {
	const images = [...markdown.matchAll(IMAGE_RE)].map((match) => match[1])
	const links = [
		...[...markdown.matchAll(LINK_RE)].map((match) =>
			match[1] === '!' ? undefined : match[2]
		),
		...[...markdown.matchAll(AUTOLINK_RE)].map((match) => match[1])
	]
	return {
		links: resolveUnique(links, baseUrl),
		images: resolveUnique(images, baseUrl)
	}
}

const ANCHOR_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
/**
 * Script, style and template bodies are not markup. A theme that builds its
 * cards in JavaScript (`'<a href="'+dipi_permalink+'">'`) otherwise hands
 * discovery hundreds of URLs ending in `+dipi_permalink+` or `'+n+'`, and
 * every one of them is a 404 the crawl waits in line for.
 */
const NON_MARKUP_RE = /<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/**
 * Every `<a href>` of the page, absolute and deduped.
 *
 * Markdown conversion is lossy about navigation: an anchor wrapped around an
 * image, a `<nav>` the converter folded away, or a menu rendered as list items
 * all lose their target. Measured on one customer homepage: 16 internal hrefs
 * in the HTML, 4 in the markdown - and one of the twelve missing links was the
 * only route to a page holding prices and opening hours. Discovery unions this
 * with the markdown links whenever an HTML tier read the page, so a page is
 * reachable if ANY representation mentions it.
 */
export function htmlLinks(html: string, baseUrl: string): string[] {
	const targets = [
		...html.replace(NON_MARKUP_RE, ' ').matchAll(ANCHOR_HREF_RE)
	].map((match) => {
		const raw = match[1]
		if (!raw) return undefined
		const first = raw[0]
		const target =
			(first === '"' || first === "'") && raw.endsWith(first)
				? raw.slice(1, -1)
				: raw
		return decodeHtmlEntities(target)
	})
	return resolveUnique(targets, baseUrl)
}

/** Conversion may omit an image-only menu; retain original and lazy asset URLs. */
export function htmlImages(html: string, baseUrl: string): string[] {
	const targets = [...html.matchAll(/<img\b[^>]*>/gi)].flatMap((tag) =>
		[
			...tag[0].matchAll(
				/\b(?:src|data-src|data-original)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
			)
		].map((attribute) => attribute[1]?.replace(/^["']|["']$/g, ''))
	)
	return resolveUnique(targets, baseUrl)
}
