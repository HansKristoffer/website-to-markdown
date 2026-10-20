import type { ApiEndpoint } from 'hanzio/api-wrapper'
import { z } from 'zod'

/**
 * POST /accounts/{account_id}/ai/tomarkdown
 * The official SDK posts octet-stream and omits conversionOptions.
 * @see https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/rest-api/
 */
export const toMarkdown = {
	method: 'POST',
	path: '/accounts/:accountId/ai/tomarkdown',
	reqParamsSchema: z.object({
		accountId: z.string()
	}),
	reqBodyFormat: 'form-data',
	reqBodySchema: z.object({
		files: z.instanceof(Blob),
		conversionOptions: z.string().optional()
	}),
	resSchema: z.object({
		success: z.boolean(),
		result: z.array(
			z.object({
				name: z.string().optional(),
				mimeType: z.string().optional(),
				format: z.string(),
				data: z.string().optional(),
				error: z.string().optional(),
				tokens: z.union([z.string(), z.number()]).optional()
			})
		)
	})
} satisfies ApiEndpoint
