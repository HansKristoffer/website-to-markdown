import Cloudflare from 'cloudflare'
import { type ApiError, createApiClient } from 'hanzio/api-wrapper'
import {
	type ConcurrencyLimit,
	type CreateConcurrencyLimit,
	createCloudflareLimits
} from './limit.js'
import { errorLogAttributes, type Logger } from './logger.js'
import {
	CloudflareRateLimitedError,
	withCloudflareRateLimitRetry
} from './rate-limit-retry.js'
import { isReportableApiError } from './report-api-error.js'
import { rateLimitFromError } from './retry-after.js'
import { toMarkdown } from './to-markdown.js'
import { BROWSER_USER_AGENT } from './user-agent.js'

export { CloudflareRateLimitedError }

/** Read on first use, so getters over a secret store work. */
export type CloudflareCredentials = {
	apiToken: string
	accountId: string
}

const BROWSER_RENDERING_TIMEOUT_MS = 60_000
/**
 * `networkidle0` never settles on Squarespace commerce pages and burned 30s
 * timeouts in the probe; `load` plus a short settle gets the same markdown.
 */
const BROWSER_RENDERING_SETTLE_MS = 1_500

export type ConvertFileInput = {
	signal?: AbortSignal | undefined
	body: string | ArrayBuffer
	/** Cloudflare picks its converter from the extension. */
	filename: string
	mimeType: string
	/** HTML only: base host for relative links. */
	hostname?: string | undefined
}

/**
 * The two Cloudflare tiers behind their pools. Rate-limit retries live in
 * `withCloudflareRateLimitRetry` so a 429 releases the slot and trips the
 * shared cooldown before the next try.
 */
export function createCloudflareClient(options: {
	credentials: CloudflareCredentials
	createLimit: CreateConcurrencyLimit
	/** Every Workers AI client error except a 429, which is retried instead. */
	onApiError?: ((error: ApiError) => void) | undefined
	/** Pass timeouts to `onApiError`; default true. */
	reportTimeouts?: boolean | undefined
	logger: Logger
}) {
	const { credentials, logger } = options
	const limits = createCloudflareLimits(options.createLimit)

	function report(error: ApiError) {
		if (isReportableApiError(error, options.reportTimeouts)) {
			options.onApiError?.(error)
		}
	}

	let cloudflareSdk: Cloudflare | undefined
	let toMarkdownApi: ReturnType<typeof createToMarkdownApi> | undefined

	function createToMarkdownApi() {
		return createApiClient({
			name: 'cloudflareToMarkdownApi',
			baseApiUrls: {
				default: 'https://api.cloudflare.com/client/v4'
			},
			defaultHeaders: {
				Authorization: `Bearer ${credentials.apiToken}`
			},
			timeoutMs: 30_000,
			retries: 0,
			onError: report,
			endpoints: {
				toMarkdown
			}
		})
	}

	function getSdk() {
		cloudflareSdk ??= new Cloudflare({ apiToken: credentials.apiToken })
		return cloudflareSdk
	}

	async function transform(file: ConvertFileInput) {
		toMarkdownApi ??= createToMarkdownApi()
		const res = await toMarkdownApi.toMarkdown({
			...(file.signal && { signal: file.signal }),
			reqParams: { accountId: credentials.accountId },
			reqBody: {
				files: new File([file.body], file.filename, {
					type: file.mimeType
				}),
				// Only the HTML converter takes options; it uses the hostname to
				// resolve relative links while it walks the document.
				conversionOptions: file.hostname
					? JSON.stringify({ html: { hostname: file.hostname } })
					: undefined
			}
		})
		return res.data
	}

	async function runWithCloudflareRateLimit<T>(input: {
		event: string
		limit: ConcurrencyLimit
		signal?: AbortSignal | undefined
		run: () => Promise<T>
	}) {
		return withCloudflareRateLimitRetry({
			event: input.event,
			signal: input.signal,
			rateLimitFromError,
			tripCooldown: (waitMs) => input.limit.tripCooldown(waitMs),
			onRateLimit: ({ attempt, waitMs }) => {
				logger.warn(`${input.event}.rate_limited`, {
					attempt,
					wait_ms: waitMs
				})
			},
			run: () => input.limit(input.run)
		})
	}

	/**
	 * Workers AI `toMarkdown` over any file it accepts - HTML, PDF, docx, xlsx,
	 * pptx. Returns null for a soft tier miss. Throws `CloudflareRateLimitedError`
	 * when 429 retries are exhausted so callers can surface a clear capture issue.
	 */
	async function convertFileWithWorkersAi(input: ConvertFileInput) {
		try {
			const envelope = await runWithCloudflareRateLimit({
				event: 'workers-ai.to-markdown',
				limit: limits.workersAi,
				signal: input.signal,
				run: () => {
					input.signal?.throwIfAborted()
					return transform(input)
				}
			})
			input.signal?.throwIfAborted()
			const first = envelope.result[0]
			if (
				!envelope.success ||
				!first ||
				first.format === 'error' ||
				!first.data?.trim()
			) {
				logger.warn('workers-ai.to-markdown.unusable', {
					success: envelope.success,
					format: first?.format ?? '',
					mime_type: input.mimeType,
					has_error: Boolean(first?.error)
				})
				return null
			}
			return first.data
		} catch (error) {
			if (error instanceof CloudflareRateLimitedError) throw error
			logger.warn('workers-ai.to-markdown.failed', errorLogAttributes(error))
			return null
		}
	}

	function convertHtmlWithWorkersAi(input: {
		html: string
		hostname: string
		signal?: AbortSignal | undefined
	}) {
		return convertFileWithWorkersAi({
			body: input.html,
			filename: 'page.html',
			mimeType: 'text/html',
			hostname: input.hostname,
			signal: input.signal
		})
	}

	async function renderUrlToMarkdown(url: string, signal?: AbortSignal) {
		try {
			const markdown = await runWithCloudflareRateLimit({
				event: 'browser-rendering',
				limit: limits.browserRendering,
				signal,
				run: () =>
					getSdk().browserRendering.markdown.create(
						{
							account_id: credentials.accountId,
							url,
							userAgent: BROWSER_USER_AGENT,
							gotoOptions: { waitUntil: 'load' },
							waitForTimeout: BROWSER_RENDERING_SETTLE_MS
						},
						{ timeout: BROWSER_RENDERING_TIMEOUT_MS, signal }
					)
			})
			return markdown.trim() || null
		} catch (error) {
			if (error instanceof CloudflareRateLimitedError) throw error
			logger.warn('browser-rendering.failed', errorLogAttributes(error))
			return null
		}
	}

	return {
		convertFileWithWorkersAi,
		convertHtmlWithWorkersAi,
		renderUrlToMarkdown
	}
}
