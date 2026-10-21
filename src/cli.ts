#!/usr/bin/env bun
/**
 * Fetch a public URL as markdown and print the result. Page metadata goes to
 * stderr; markdown goes to stdout.
 */
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import {
	type CliIO,
	CliError,
	CliUsageError,
	defineCli,
	defineCommand
} from 'hanzio/cli'
import { z } from 'zod'
import { createWebsiteToMarkdown } from './fetch-page.js'

export const cli = defineCli({
	name: 'website-to-markdown',
	// No URL prints the help and exits 1, as 1.0 did.
	onError: (error, io) => {
		if (
			error instanceof CliUsageError &&
			error.message.split('\n').some((line) => line.startsWith('<url>: '))
		) {
			io.stdout.write(error.help)
			return 1
		}
	},
	commands: defineCommand({
		// Unknown flags and extra positionals are ignored, as in 1.0.
		strict: false,
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
				),
			envFile: z
				.string()
				.optional()
				.describe('Read CLOUDFLARE_* from a dotenv file; the environment wins.')
		}),
		run: async ({ url, render, envFile }, ctx) => {
			const file = envFile ? parseEnv(await readEnvFile(envFile)) : {}
			const CLOUDFLARE_API_TOKEN =
				ctx.env.CLOUDFLARE_API_TOKEN || file.CLOUDFLARE_API_TOKEN
			const CLOUDFLARE_ACCOUNT_ID =
				ctx.env.CLOUDFLARE_ACCOUNT_ID || file.CLOUDFLARE_ACCOUNT_ID
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

function readEnvFile(path: string) {
	return readFile(path, 'utf8').catch(() => {
		throw new CliError(`Cannot read --env-file ${path}.`)
	})
}

/** The bin. `--help` without a URL exits 1, as in 1.0. */
export async function main(argv: readonly string[], io?: CliIO) {
	const code = await cli.run(argv, io)
	return code === 0 && argv.every((arg) => arg.startsWith('-')) ? 1 : code
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
