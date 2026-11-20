import { expect, test } from 'bun:test'
import * as runtime from '../index.js'
import {
	CAPTURE_ISSUES,
	CRAWL_SNAPSHOT_NAME_PATTERN,
	FETCH_SOURCES
} from './index.js'

test('is the pattern the runtime checks', () => {
	expect(CRAWL_SNAPSHOT_NAME_PATTERN).toBe(runtime.CRAWL_SNAPSHOT_NAME_PATTERN)
	expect(FETCH_SOURCES).toContain('local-html')
	expect(FETCH_SOURCES).toContain('local-csv')
	expect(CAPTURE_ISSUES).toContain('cloudflare_not_configured')
})

test('imports nothing, so a shared schema can use it', async () => {
	const source = await Bun.file(new URL('./index.ts', import.meta.url)).text()
	expect(source).not.toMatch(/^\s*(import|export .* from)\b/m)
})
