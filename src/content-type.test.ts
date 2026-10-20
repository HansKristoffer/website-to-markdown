import { describe, expect, test } from 'bun:test'
import { classifyContentType, convertibleDocumentType } from './content-type.js'

describe('classifyContentType', () => {
	test('classifies the tiers a page can arrive on', () => {
		expect(classifyContentType('text/markdown; charset=utf-8')).toBe('markdown')
		expect(classifyContentType('text/html; charset=iso-8859-1')).toBe('html')
		expect(classifyContentType('application/xhtml+xml')).toBe('html')
		expect(classifyContentType('text/plain')).toBe('text')
		expect(classifyContentType('application/json')).toBe('text')
		expect(classifyContentType(null)).toBe('text')
	})

	test('classifies convertible documents', () => {
		expect(classifyContentType('application/pdf')).toBe('document')
		expect(
			classifyContentType(
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
			)
		).toBe('document')
	})

	test('classifies assets we must not download', () => {
		for (const type of [
			'image/jpeg',
			'image/svg+xml',
			'font/woff2',
			'video/mp4',
			'audio/mpeg',
			'application/javascript',
			'application/zip',
			'application/octet-stream'
		]) {
			expect(classifyContentType(type)).toBe('asset')
		}
	})

	test('an extensionless image handler URL is judged by its header alone', () => {
		// tandlaegen.dk serves every image from /Admin/Public/GetImage.ashx?image=…
		expect(classifyContentType('image/png')).toBe('asset')
	})
})

describe('convertibleDocumentType', () => {
	test('maps a mime type to the upload extension Cloudflare needs', () => {
		expect(convertibleDocumentType('application/pdf; charset=binary')).toEqual({
			extension: 'pdf',
			mimeType: 'application/pdf'
		})
		expect(convertibleDocumentType('text/html')).toBeNull()
	})

	test('does not resolve a content type through Object.prototype', () => {
		expect(convertibleDocumentType('constructor')).toBeNull()
		expect(classifyContentType('constructor')).toBe('asset')
	})
})
