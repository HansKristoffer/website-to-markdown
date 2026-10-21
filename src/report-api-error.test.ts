import { expect, test } from 'bun:test'
import {
	HttpResponseError,
	NetworkError,
	RequestTimeoutError
} from 'hanzio/api-wrapper'
import { isReportableApiError } from './report-api-error.js'

const context = {
	endpoint: 'toMarkdown',
	method: 'POST' as const,
	url: 'https://api.cloudflare.com/client/v4',
	attempt: 1,
	maxRetries: 0,
	elapsedMs: 30_000
}

test('429s are never reported; timeouts only with reportTimeouts', () => {
	const timeout = new RequestTimeoutError(30_000, context)
	const rateLimited = new HttpResponseError(429, '', {}, context)
	const failed = new HttpResponseError(500, '', {}, context)
	const network = new NetworkError('reset', context)

	expect(isReportableApiError(rateLimited)).toBe(false)
	expect(isReportableApiError(timeout)).toBe(true)
	expect(isReportableApiError(timeout, false)).toBe(false)
	expect(isReportableApiError(failed, false)).toBe(true)
	expect(isReportableApiError(network, false)).toBe(true)
})
