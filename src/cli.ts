#!/usr/bin/env bun
/**
 * Fetch a public URL as markdown and print the result. Page metadata goes to
 * stderr; markdown goes to stdout.
 */
import { createWebsiteToMarkdown } from './fetch-page.js'

const HELP = `
Fetch a public URL as markdown.

Usage:
  website-to-markdown <url> [--no-render]

Options:
  --no-render   Skip the Browser Rendering tier (HTML tiers only).

Environment:
  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

Example:
  website-to-markdown https://example.com/about
`.trim()

const args = Bun.argv.slice(2)
const url = args.find((arg) => !arg.startsWith('-'))
if (!url || args.includes('-h') || args.includes('--help')) {
	console.log(HELP)
	process.exit(url ? 0 : 1)
}

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = process.env
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) {
	console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.')
	process.exit(1)
}

const { fetchPageAsMarkdown } = createWebsiteToMarkdown({
	cloudflare: {
		apiToken: CLOUDFLARE_API_TOKEN,
		accountId: CLOUDFLARE_ACCOUNT_ID
	}
})

console.error(`Fetching ${url}…`)

const page = await fetchPageAsMarkdown({
	url,
	render: !args.includes('--no-render')
})

console.error(
	JSON.stringify(
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
	)
)

console.log(page.markdown)
if (page.outcome !== 'ok') process.exit(1)
