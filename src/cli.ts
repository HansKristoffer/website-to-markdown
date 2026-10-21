#!/usr/bin/env bun
/**
 * Fetch a public URL as markdown and print the result. Page metadata goes to
 * stderr; markdown goes to stdout.
 */
import { type CliIO, CliError, defineCli, defineCommand } from 'hanzio/cli'
import { z } from 'zod'
import { createWebsiteToMarkdown } from './fetch-page.js'

export const cli = defineCli({
	name: 'website-to-markdown',
	commands: defineCommand({
		description:
			'Fetch a public URL as markdown. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.',
		input: z.object({
			url: z
				.string()
				.describe('e.g. https://example.com/about')
				.meta({ positional: true }),
			render: z
				.boolean()
				.default(true)
				.describe(
					'Use the Browser Rendering tier; --no-render keeps to HTML tiers.'
				)
		}),
		run: async ({ url, render }, ctx) => {
			const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = ctx.env
			if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID)
				throw new CliError(
					'Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.'
				)

			const { fetchPageAsMarkdown } = createWebsiteToMarkdown({
				cloudflare: {
					apiToken: CLOUDFLARE_API_TOKEN,
					accountId: CLOUDFLARE_ACCOUNT_ID
				}
			})

			ctx.stderr.write(`Fetching ${url}…\n`)

			const page = await fetchPageAsMarkdown({ url, render })

			ctx.stderr.write(
				`${JSON.stringify(
					{
						outcome: page.outcome,
						status: page.status,
						source: page.source,
						url: page.url,
						finalUrl: page.finalUrl,
						contentType: page.contentType,
						etag: page.etag,
						lastModified: page.lastModified,
						title: page.title,
						lang: page.lang,
						canonical: page.canonical,
						metaDescription: page.metaDescription,
						jsonLdBlocks: page.jsonLd.length,
						links: page.links.length,
						images: page.images.length,
						markdownChars: page.markdown.length,
						durationMs: page.durationMs
					},
					null,
					2
				)}\n`
			)

			if (page.outcome !== 'ok') ctx.exitCode = 1
			return page.markdown
		}
	})
})

/** The bin: 1.0 printed the help and exited 1 when no URL was given, even with `--help`. */
export async function main(argv: readonly string[], io?: CliIO) {
	if (argv.some((arg) => !arg.startsWith('-'))) return cli.run(argv, io)
	await cli.run(['--help'], io)
	return 1
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
