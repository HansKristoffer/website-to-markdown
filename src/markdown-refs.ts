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
 * `### Page N`. None of it is what the document says, and the fact guard
 * demanded those dates and numbers of every written document - which is how
 * Hotel Hvide Klit's terms came back as 13,000 characters of raw text with
 * the PDF metadata inside.
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
		if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
			return null
		}
		// Cloudflare's reserved prefix is plumbing, never a page: the e-mail
		// obfuscation endpoint under it answers 410, which used to count as a
		// page this site failed to deliver. `clean-pages.ts` decodes the address
		// out of the link before it is dropped here.
		if (resolved.pathname.startsWith('/cdn-cgi/')) return null
		return resolved.href
	} catch {
		return null
	}
}

/**
 * Absolute, deduped, document-order links and images. Discovery crawls these,
 * so relative targets (`/kontakt`) and CMS-escaped query strings
 * (`?image=x&amp;width=200`) have to come out resolved and decoded.
 */
export function markdownRefs(markdown: string, baseUrl: string) {
	const links: string[] = []
	const images: string[] = []
	const seenLinks = new Set<string>()
	const seenImages = new Set<string>()

	const push = (isImage: boolean, target: string) => {
		const resolved = resolveTarget(target, baseUrl)
		if (!resolved) return
		const seen = isImage ? seenImages : seenLinks
		if (seen.has(resolved)) return
		seen.add(resolved)
		;(isImage ? images : links).push(resolved)
	}

	for (const match of markdown.matchAll(IMAGE_RE)) {
		if (match[1]) push(true, match[1])
	}
	for (const match of markdown.matchAll(LINK_RE)) {
		if (match[1] !== '!' && match[2]) push(false, match[2])
	}
	for (const match of markdown.matchAll(AUTOLINK_RE)) {
		if (match[1]) push(false, match[1])
	}

	return { links, images }
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
	const links: string[] = []
	const seen = new Set<string>()
	for (const match of html
		.replace(NON_MARKUP_RE, ' ')
		.matchAll(ANCHOR_HREF_RE)) {
		const raw = match[1]
		if (!raw) continue
		const first = raw[0]
		const target =
			(first === '"' || first === "'") && raw.endsWith(first)
				? raw.slice(1, -1)
				: raw
		const resolved = resolveTarget(decodeHtmlEntities(target), baseUrl)
		if (!resolved || seen.has(resolved)) continue
		seen.add(resolved)
		links.push(resolved)
	}
	return links
}

/** Conversion may omit an image-only menu; retain original and lazy asset URLs. */
export function htmlImages(html: string, baseUrl: string): string[] {
	const images = new Set<string>()
	for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
		for (const attribute of tag[0].matchAll(
			/\b(?:src|data-src|data-original)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
		)) {
			const raw = attribute[1]
			if (!raw) continue
			const url = resolveTarget(raw.replace(/^["']|["']$/g, ''), baseUrl)
			if (url) images.add(url)
		}
	}
	return [...images]
}
