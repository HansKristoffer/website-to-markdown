import { expect, test } from 'bun:test'
import * as runtime from '../index.js'
import { CRAWL_SNAPSHOT_NAME_PATTERN } from './index.js'

test('is the pattern the runtime checks', () => {
	expect(CRAWL_SNAPSHOT_NAME_PATTERN).toBe(runtime.CRAWL_SNAPSHOT_NAME_PATTERN)
})

test('imports nothing, so a shared schema can use it', async () => {
	const source = await Bun.file(new URL('./index.ts', import.meta.url)).text()
	expect(source).not.toMatch(/^\s*(import|export .* from)\b/m)
})
