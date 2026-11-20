import { type HTMLElement, type Node, NodeType, parse } from 'node-html-parser'
import {
	cleanConvertedMarkdown,
	decodeCloudflareEmail
} from './markdown-refs.js'

const SKIP_TAGS = new Set([
	'script',
	'style',
	'noscript',
	'svg',
	'template',
	'iframe',
	'object',
	'embed',
	'canvas',
	'head',
	'meta',
	'link',
	'title',
	'select',
	'option',
	'optgroup',
	'textarea',
	'input',
	'audio',
	'video',
	'source',
	'track',
	'map',
	'area'
])

const BLOCK_TAGS = new Set([
	'address',
	'article',
	'aside',
	'blockquote',
	'dd',
	'details',
	'dialog',
	'div',
	'dl',
	'dt',
	'fieldset',
	'figcaption',
	'figure',
	'footer',
	'form',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'hgroup',
	'hr',
	'li',
	'main',
	'nav',
	'ol',
	'p',
	'pre',
	'section',
	'summary',
	'table',
	'ul'
])

const TYPOGRAPHIC_INLINE_TAGS = new Set([
	'b',
	'strong',
	'i',
	'em',
	'u',
	's',
	'del',
	'ins',
	'mark',
	'sup',
	'sub',
	'abbr',
	'cite',
	'code'
])

const RAW_SKIP_BLOCKS_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const INLINE_DISPLAY_NONE_RE = /(?:^|;)\s*display\s*:\s*none\b/i
const CLOSING_PUNCT_RE = /^[,.;:!?)\]}»”"’']/
const OPENING_PUNCT_RE = /[([{«“"'\-/–—]$/
const CF_EMAIL_HREF_RE =
	/(?:^|\/)cdn-cgi\/l\/email-protection(?:#([0-9a-fA-F]{8,}))?$/i
const CF_EMAIL_PLACEHOLDER_RE = /^\[email[\s\u00a0]+protected\]$/i
const HEADING_LINE_RE = /^(#{1,6}\s+)(.+)$/
const PURE_IMAGE_LINE_RE = /^!\[[^\]]*\]\([^)]+\)$/
const STRUCTURAL_LINE_RE = /^(?:[|>]|```|---$|(?:-|\d+\.)\s)/

type RenderedPart = {
	text: string
	tag: string | null
	block: boolean
}

type RenderContext = {
	baseUrl: string | undefined
	inInline: boolean
	inHiddenBlock: boolean
	inLink: boolean
	inStrong: boolean
	inEm: boolean
	inDel: boolean
	listDepth: number
}

function isElement(node: Node): node is HTMLElement {
	return node.nodeType === NodeType.ELEMENT_NODE
}

function tagOf(element: HTMLElement) {
	return (element.rawTagName || element.tagName || '').toLowerCase()
}

function isHiddenElement(element: HTMLElement, tag: string) {
	if (tag === 'dialog' && !element.hasAttribute('open')) return true
	if (tag === 'form') {
		const action = (element.getAttribute('action') ?? '').toLowerCase()
		if (action.includes('/contact')) return true
	}
	return false
}

function hasDisplayNone(element: HTMLElement) {
	const style = element.getAttribute('style')
	return Boolean(style && INLINE_DISPLAY_NONE_RE.test(style))
}

function collapseInlineWhitespace(text: string) {
	return text.replaceAll('\u00ad', '').replace(/[\r\n\t \u00a0]+/g, ' ')
}

function formatMarkdownUrl(url: string) {
	return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s+/g, '%20')
}

function resolveUrl(raw: string | undefined, baseUrl: string | undefined) {
	const value = raw?.trim() ?? ''
	if (!value || value.startsWith('#')) return null
	if (/^(?:javascript|vbscript|data):/i.test(value)) return null
	if (/^(?:mailto|tel):/i.test(value)) return value
	if (!baseUrl) return /^https?:\/\//i.test(value) ? value : null
	try {
		const resolved = new URL(value, baseUrl)
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
			return null
		}
		return resolved.href
	} catch {
		return null
	}
}

function edgeChar(text: string, side: 'start' | 'end') {
	const stripped =
		side === 'start' ? text.replace(/^[*~`]+/, '') : text.replace(/[*~`]+$/, '')
	return side === 'start' ? (stripped[0] ?? '') : (stripped.at(-1) ?? '')
}

function needsGapBetween(
	left: string,
	right: string,
	leftTag: string | null,
	rightTag: string | null
) {
	if (!left || !right) return false
	if (/\s$/.test(left) || /^\s/.test(right)) return false
	// Block elements rendered inline (e.g. `<p>` inside `<td>`) stay separated.
	if (
		(leftTag !== null && BLOCK_TAGS.has(leftTag)) ||
		(rightTag !== null && BLOCK_TAGS.has(rightTag))
	) {
		return true
	}
	if (
		(!right.startsWith('![') && CLOSING_PUNCT_RE.test(right)) ||
		OPENING_PUNCT_RE.test(left)
	) {
		return false
	}
	// Keep a typographic wrapper attached to adjacent plain text when it styles
	// part of one lowercase word (`un<strong>happy</strong>`), while separating
	// sibling elements (`<span>Label</span><strong>value</strong>`).
	const oneSideText = leftTag === null || rightTag === null
	const typographic =
		(leftTag !== null && TYPOGRAPHIC_INLINE_TAGS.has(leftTag)) ||
		(rightTag !== null && TYPOGRAPHIC_INLINE_TAGS.has(rightTag))
	if (oneSideText && typographic) {
		const leftEnd = edgeChar(left, 'end')
		const rightStart = edgeChar(right, 'start')
		if (/\p{Ll}/u.test(leftEnd) && /\p{Ll}/u.test(rightStart)) return false
	}
	return leftTag !== null || rightTag !== null
}

function joinParts(parts: RenderedPart[]) {
	let out = ''
	let prevTag: string | null = null
	let prevBlock = false

	for (const part of parts) {
		if (!part.text) continue
		if (part.block) {
			const trimmed = part.text.trim()
			if (!trimmed) continue
			if (out.length > 0) {
				out = out.trimEnd()
				out += '\n\n'
			}
			out += trimmed
			prevTag = part.tag
			prevBlock = true
			continue
		}

		if (prevBlock && out.length > 0) {
			const trimmedStart = part.text.replace(/^\s+/, '')
			if (!trimmedStart) continue
			out = `${out.trimEnd()}\n\n${trimmedStart}`
			prevTag = part.tag
			prevBlock = false
			continue
		}

		let text = part.text
		if (/\s$/.test(out) && /^\s/.test(text)) {
			text = text.replace(/^\s+/, '')
			if (!text) continue
		}
		if (out.length > 0 && needsGapBetween(out, text, prevTag, part.tag)) {
			out += ' '
		}
		out += text
		prevTag = part.tag
		prevBlock = false
	}

	return out
}

function wrapInline(raw: string, marker: string, alreadyWrapped: boolean) {
	const leading = /^\s/.test(raw) ? ' ' : ''
	const trailing = /\s$/.test(raw) ? ' ' : ''
	const inner = raw.trim()
	if (!inner) return ''
	if (alreadyWrapped) return `${leading}${inner}${trailing}`
	return `${leading}${marker}${inner}${marker}${trailing}`
}

function hasBlockDescendant(element: HTMLElement): boolean {
	for (const child of element.childNodes) {
		if (!isElement(child)) continue
		const tag = tagOf(child)
		if (SKIP_TAGS.has(tag)) continue
		if (BLOCK_TAGS.has(tag) || hasBlockDescendant(child)) return true
	}
	return false
}

function renderChildren(element: HTMLElement, ctx: RenderContext): string {
	const parts: RenderedPart[] = []
	for (const child of element.childNodes) {
		if (child.nodeType === NodeType.TEXT_NODE) {
			const text = collapseInlineWhitespace(child.text)
			if (text) parts.push({ text, tag: null, block: false })
			continue
		}
		if (!isElement(child)) continue
		const rendered = renderElement(child, ctx)
		if (rendered.text) parts.push(rendered)
	}
	return joinParts(parts)
}

function renderTable(table: HTMLElement, ctx: RenderContext): string {
	const captionElement = table.childNodes
		.filter(isElement)
		.find((child) => tagOf(child) === 'caption')
	const caption = captionElement
		? renderChildren(captionElement, { ...ctx, inInline: true })
				.replace(/\s+/g, ' ')
				.trim()
		: ''

	const rows = table
		.querySelectorAll('tr')
		.filter((row) => row.closest('table') === table)
	const grid: string[][] = []

	for (const row of rows) {
		const cells = row.childNodes
			.filter(isElement)
			.filter((cell) => {
				const tag = tagOf(cell)
				return tag === 'td' || tag === 'th'
			})
			.map((cell) =>
				renderChildren(cell, { ...ctx, inInline: true })
					.replace(/\s+/g, ' ')
					.replace(/\|/g, '\\|')
					.trim()
			)
		if (cells.length > 0 && cells.some((cell) => cell.length > 0)) {
			grid.push(cells)
		}
	}

	if (grid.length === 0) return caption

	const colCount = Math.max(...grid.map((row) => row.length))
	// Single-column tables are layout wrappers, not tabular data.
	if (colCount <= 1) {
		const paragraphs = grid.map((row) => row[0] ?? '').filter(Boolean)
		return caption
			? [caption, ...paragraphs].join('\n\n')
			: paragraphs.join('\n\n')
	}

	const padRow = (row: string[]) =>
		Array.from({ length: colCount }, (_, index) => row[index] ?? '')
	const header = padRow(grid[0]!)
	const body = grid.slice(1).map(padRow)
	const tableMarkdown = [
		`| ${header.join(' | ')} |`,
		`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
		...body.map((row) => `| ${row.join(' | ')} |`)
	].join('\n')
	return caption ? `**${caption}**\n\n${tableMarkdown}` : tableMarkdown
}

function renderList(
	list: HTMLElement,
	ordered: boolean,
	ctx: RenderContext
): string {
	const indent = '  '.repeat(ctx.listDepth)
	const items = list.childNodes
		.filter(isElement)
		.filter((child) => tagOf(child) === 'li')
	const lines: string[] = []
	const parsedStart = ordered
		? Number.parseInt(list.getAttribute('start') ?? '', 10)
		: Number.NaN
	let index = Number.isFinite(parsedStart) && parsedStart >= 0 ? parsedStart : 1

	for (const item of items) {
		const content = renderChildren(item, {
			...ctx,
			listDepth: ctx.listDepth + 1
		}).trim()
		if (!content) continue
		const marker = ordered ? `${index}. ` : '- '
		index += 1
		const sublines = content.split('\n')
		const first = `${indent}${marker}${sublines[0]}`
		const rest = sublines
			.slice(1)
			.map((line) => (line.trim() ? `${indent}  ${line}` : ''))
		lines.push([first, ...rest].join('\n'))
	}
	return lines.join('\n')
}

function findDescendantCfEmail(element: HTMLElement): string | null {
	const node = element.querySelector('[data-cfemail]')
	const hex = node?.getAttribute('data-cfemail')
	return hex ? decodeCloudflareEmail(hex) : null
}

function linkBlockLines(body: string, href: string) {
	const target = formatMarkdownUrl(href)
	const lines = body.split('\n')

	const headingIndex = lines.findIndex((line) =>
		HEADING_LINE_RE.test(line.trim())
	)
	if (headingIndex >= 0) {
		const match = HEADING_LINE_RE.exec(lines[headingIndex]!.trim())!
		lines[headingIndex] = `${match[1]}[${match[2]!.trim()}](${target})`
		return lines.join('\n')
	}

	const nonEmptyIndices = lines
		.map((line, index) => ({ line: line.trim(), index }))
		.filter(({ line }) => line.length > 0)
	if (nonEmptyIndices.length === 0) return body

	const plainTextLine = nonEmptyIndices.find(
		({ line }) =>
			!PURE_IMAGE_LINE_RE.test(line) && !STRUCTURAL_LINE_RE.test(line)
	)
	if (plainTextLine) {
		lines[plainTextLine.index] = `[${plainTextLine.line}](${target})`
		return lines.join('\n')
	}

	const first = nonEmptyIndices[0]!
	if (PURE_IMAGE_LINE_RE.test(first.line)) {
		lines[first.index] = `[${first.line}](${target})`
		return lines.join('\n')
	}
	return body
}

function renderLink(element: HTMLElement, ctx: RenderContext): RenderedPart {
	const rawHref = element.getAttribute('href')
	const cfEmail = element.getAttribute('data-cfemail')
	if (cfEmail) {
		const email = decodeCloudflareEmail(cfEmail)
		if (email) {
			return {
				text: ctx.inLink ? email : `[${email}](mailto:${email})`,
				tag: 'a',
				block: false
			}
		}
	}

	const childCtx: RenderContext = { ...ctx, inLink: true }
	const cfHrefMatch = rawHref ? CF_EMAIL_HREF_RE.exec(rawHref.trim()) : null
	if (cfHrefMatch) {
		const decoded =
			(cfHrefMatch[1] ? decodeCloudflareEmail(cfHrefMatch[1]) : null) ??
			findDescendantCfEmail(element)
		if (decoded) {
			const rawLabel = renderChildren(element, { ...childCtx, inInline: true })
			const leading = /^\s/.test(rawLabel) ? ' ' : ''
			const trailing = /\s$/.test(rawLabel) ? ' ' : ''
			const collapsed = rawLabel.replace(/\s+/g, ' ').trim()
			const label =
				!collapsed || CF_EMAIL_PLACEHOLDER_RE.test(collapsed)
					? decoded
					: collapsed
			return {
				text: ctx.inLink
					? `${leading}${label}${trailing}`
					: `${leading}[${label}](mailto:${decoded})${trailing}`,
				tag: 'a',
				block: false
			}
		}
	}

	const href = resolveUrl(rawHref, ctx.baseUrl)

	// A whole card wrapped inside one `<a>` (headings + paragraphs + prices):
	// keep its internal block structure so card fields do not glue together.
	if (!ctx.inInline && hasBlockDescendant(element)) {
		const body = renderChildren(element, childCtx).trim()
		if (!body) return { text: '', tag: 'a', block: true }
		if (!href || ctx.inLink) return { text: body, tag: 'a', block: true }
		return { text: linkBlockLines(body, href), tag: 'a', block: true }
	}

	const rawLabel = renderChildren(element, { ...childCtx, inInline: true })
	const leading = /^\s/.test(rawLabel) ? ' ' : ''
	const trailing = /\s$/.test(rawLabel) ? ' ' : ''
	const label = rawLabel.replace(/\s+/g, ' ').trim()
	if (!label) return { text: '', tag: 'a', block: false }
	if (!href || ctx.inLink) {
		return { text: `${leading}${label}${trailing}`, tag: 'a', block: false }
	}
	return {
		text: `${leading}[${label}](${formatMarkdownUrl(href)})${trailing}`,
		tag: 'a',
		block: false
	}
}

function renderElement(element: HTMLElement, ctx: RenderContext): RenderedPart {
	const tag = tagOf(element)
	if (SKIP_TAGS.has(tag) || isHiddenElement(element, tag)) {
		return { text: '', tag, block: false }
	}
	const hidden = ctx.inHiddenBlock || hasDisplayNone(element)
	if (hidden && tag === 'label') {
		return { text: '', tag, block: false }
	}

	const cfEmail = element.getAttribute('data-cfemail')
	if (cfEmail) {
		const email = decodeCloudflareEmail(cfEmail)
		if (email) {
			return {
				text: ctx.inLink ? email : `[${email}](mailto:${email})`,
				tag,
				block: false
			}
		}
	}

	const nextCtx: RenderContext = {
		...ctx,
		inHiddenBlock: hidden
	}

	if (tag === 'br') {
		return { text: ctx.inInline ? ' ' : '\n', tag, block: false }
	}
	if (tag === 'hr') {
		return { text: '---', tag, block: !ctx.inInline }
	}
	if (tag === 'img') {
		const src =
			resolveUrl(element.getAttribute('src'), ctx.baseUrl) ??
			resolveUrl(element.getAttribute('data-src'), ctx.baseUrl) ??
			resolveUrl(element.getAttribute('data-original'), ctx.baseUrl) ??
			resolveUrl(element.getAttribute('data-lazy-src'), ctx.baseUrl)
		if (!src) return { text: '', tag, block: false }
		const alt = (element.getAttribute('alt') ?? '')
			.replaceAll('\u00ad', '')
			.replace(/\s+/g, ' ')
			.replace(/[[\]]/g, '')
			.trim()
		return { text: `![${alt}](${formatMarkdownUrl(src)})`, tag, block: false }
	}
	if (tag === 'a') {
		return renderLink(element, nextCtx)
	}
	if (/^h[1-6]$/.test(tag)) {
		const level = Number(tag[1])
		const headingText = renderChildren(element, { ...nextCtx, inInline: true })
			.replace(/\s+/g, ' ')
			.trim()
		if (!headingText) return { text: '', tag, block: !ctx.inInline }
		if (ctx.inInline) return { text: headingText, tag, block: false }
		return {
			text: `${'#'.repeat(level)} ${headingText}`,
			tag,
			block: true
		}
	}
	if (tag === 'pre') {
		const code = element.text
			.replaceAll('\u00ad', '')
			.replace(/\r\n?/g, '\n')
			.trim()
		if (!code) return { text: '', tag, block: !ctx.inInline }
		if (ctx.inInline) {
			const inline = code.replace(/\s+/g, ' ')
			const fence = inline.includes('`') ? '``' : '`'
			return { text: `${fence}${inline}${fence}`, tag, block: false }
		}
		const fence = code.includes('```') ? '````' : '```'
		return { text: `${fence}\n${code}\n${fence}`, tag, block: true }
	}
	if (tag === 'code') {
		const raw = element.text.replaceAll('\u00ad', '')
		const leading = /^\s/.test(raw) ? ' ' : ''
		const trailing = /\s$/.test(raw) ? ' ' : ''
		const code = raw.replace(/[\r\n\t \u00a0]+/g, ' ').trim()
		if (!code) return { text: '', tag, block: false }
		const fence = code.includes('`') ? '``' : '`'
		const padded =
			fence.length > 1 && (code.startsWith('`') || code.endsWith('`'))
				? ` ${code} `
				: code
		return {
			text: `${leading}${fence}${padded}${fence}${trailing}`,
			tag,
			block: false
		}
	}
	if (tag === 'strong' || tag === 'b') {
		const raw = renderChildren(element, {
			...nextCtx,
			inInline: true,
			inStrong: true
		})
		return { text: wrapInline(raw, '**', ctx.inStrong), tag, block: false }
	}
	if (tag === 'em' || tag === 'i') {
		const raw = renderChildren(element, {
			...nextCtx,
			inInline: true,
			inEm: true
		})
		return { text: wrapInline(raw, '*', ctx.inEm), tag, block: false }
	}
	if (tag === 'del' || tag === 's') {
		const raw = renderChildren(element, {
			...nextCtx,
			inInline: true,
			inDel: true
		})
		return { text: wrapInline(raw, '~~', ctx.inDel), tag, block: false }
	}
	if (tag === 'blockquote') {
		const inner = renderChildren(element, nextCtx).trim()
		if (!inner) return { text: '', tag, block: !ctx.inInline }
		if (ctx.inInline) return { text: inner, tag, block: false }
		const quoted = inner
			.split('\n')
			.map((line) => (line.trim() ? `> ${line}` : '>'))
			.join('\n')
		return { text: quoted, tag, block: true }
	}
	if (tag === 'ul' || tag === 'ol') {
		const rendered = renderList(element, tag === 'ol', nextCtx)
		return { text: rendered, tag, block: !ctx.inInline }
	}
	if (tag === 'table') {
		const rendered = renderTable(element, nextCtx)
		return { text: rendered, tag, block: !ctx.inInline }
	}
	if (tag === 'dt') {
		const term = renderChildren(element, { ...nextCtx, inInline: true })
			.replace(/\s+/g, ' ')
			.trim()
		return {
			text: term ? `**${term}**` : '',
			tag,
			block: !ctx.inInline
		}
	}
	if (tag === 'dd') {
		const def = renderChildren(element, nextCtx).trim()
		return { text: def, tag, block: !ctx.inInline }
	}

	const isBlock = BLOCK_TAGS.has(tag) && !ctx.inInline
	const content = renderChildren(element, nextCtx)
	return { text: content, tag, block: isBlock }
}

/**
 * Converts HTML into clean, well-spaced GFM Markdown locally without a network
 * round trip. Preserves tables, headings, lists, links and images, strips
 * hidden UI/scripts/forms/dropdowns, decodes Cloudflare email obfuscation, and
 * separates adjacent flex/grid elements so card layouts never glue words.
 */
export function localHtmlToMarkdown(html: string, baseUrl?: string): string {
	// Pre-strip raw `<script>` and `<style>` blocks so `node-html-parser` does
	// not spend time scanning `<` comparisons inside large inline JS/CSS bundles.
	const stripped = html.replace(RAW_SKIP_BLOCKS_RE, '')
	const root = parse(stripped, {
		lowerCaseTagName: true,
		comment: false,
		blockTextElements: {
			script: false,
			noscript: false,
			style: false,
			textarea: false
		}
	})
	const container = root.querySelector('body') ?? root
	const raw = renderChildren(container, {
		baseUrl,
		inInline: false,
		inHiddenBlock: false,
		inLink: false,
		inStrong: false,
		inEm: false,
		inDel: false,
		listDepth: 0
	})

	return cleanConvertedMarkdown(raw)
		.replaceAll('\u0000', '')
		.normalize('NFC')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}
