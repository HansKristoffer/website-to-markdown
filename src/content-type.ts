const MARKDOWN_CONTENT_TYPES = new Set([
	'text/markdown',
	'text/x-markdown',
	'application/markdown'
])

const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml'])

const TEXTUAL_CONTENT_TYPES = new Set([
	'application/xml',
	'application/json',
	'application/rss+xml',
	'application/atom+xml'
])

/**
 * The formats Workers AI `toMarkdown` accepts as documents (its `/supported`
 * list, read 2026-09-08). Images are accepted there too but are deliberately
 * absent: this list decides what the CRAWLER downloads and converts, and a
 * site's gallery must stay an asset. Uploads accept images on their own list.
 */
const CONVERTIBLE_DOCUMENT_EXTENSIONS = new Map([
	['application/pdf', 'pdf'],
	[
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'docx'
	],
	['application/vnd.oasis.opendocument.text', 'odt'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
	['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsm'],
	['application/vnd.ms-excel.sheet.binary.macroenabled.12', 'xlsb'],
	['application/vnd.ms-excel', 'xls'],
	['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
	[
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'pptx'
	],
	[
		'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
		'ppsx'
	],
	['application/vnd.oasis.opendocument.presentation', 'odp']
])

function normalizeContentType(contentType: string | null | undefined) {
	return contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isTextualContentType(type: string) {
	return (
		type === '' ||
		type.startsWith('text/') ||
		TEXTUAL_CONTENT_TYPES.has(type) ||
		// `application/ld+json`, `application/rdf+xml`, … but not `image/svg+xml`.
		(type.startsWith('application/') &&
			(type.endsWith('+json') || type.endsWith('+xml')))
	)
}

/** The upload descriptor for a binary we can convert, or null for text/assets. */
export function convertibleDocumentType(contentType: string | null) {
	const mimeType = normalizeContentType(contentType)
	const extension = CONVERTIBLE_DOCUMENT_EXTENSIONS.get(mimeType)
	return extension ? { extension, mimeType } : null
}

export type ContentKind = 'markdown' | 'html' | 'text' | 'document' | 'asset'

/** What the fetch layer should do with a body, decided from the header alone. */
export function classifyContentType(contentType: string | null): ContentKind {
	const type = normalizeContentType(contentType)
	if (MARKDOWN_CONTENT_TYPES.has(type)) return 'markdown'
	if (HTML_CONTENT_TYPES.has(type)) return 'html'
	if (CONVERTIBLE_DOCUMENT_EXTENSIONS.has(type)) return 'document'
	if (isTextualContentType(type)) return 'text'
	return 'asset'
}
