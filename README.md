# website-to-markdown

Turn URLs, HTML and files into markdown through Cloudflare's tiers (content
negotiation, Workers AI `toMarkdown`, Browser Rendering), with an SSRF guard,
per-host politeness limits, `Retry-After` handling, crawl snapshots for
benchmarks, and robots.txt + sitemap discovery. Runs on Bun (it uses
`HTMLRewriter`).

```sh
bun add website-to-markdown hanzio zod
```

## Convert

```ts
import { createWebsiteToMarkdown } from 'website-to-markdown'

const converter = createWebsiteToMarkdown({
	// Read on first use, so getters over a secret store work.
	cloudflare: { apiToken: '…', accountId: '…' }
})

const page = await converter.fetchPageAsMarkdown({ url: 'https://example.com' })
if (page.outcome === 'ok') console.log(page.title, page.markdown, page.links)
```

`fetchPageAsMarkdown` never throws: a page that cannot be read comes back as
an `outcome` (`unchanged`, `gone`, `blocked`, `transient`, `unsupported`).
Pass the last read's `etag`, `lastModified` or `htmlHash` to get `unchanged`
without converting again. `convertDocumentBytes` converts an uploaded file;
`urlToMarkdown` is the one-shot form that throws.

Create one converter per process: it owns the Cloudflare pools and the
per-host limits.

### Options

| Option | Default | |
|---|---|---|
| `cloudflare` | required | `{ apiToken, accountId }` |
| `createLimit` | `createMemoryConcurrencyLimit` | Builds every pool. Pass a shared (Redis) limiter when several processes share the Cloudflare quota. |
| `onApiError` | none | Workers AI client errors (hanzio `ApiError`) other than 429s. |
| `logger` | silent | `{ info, warn }` |
| `parsePdf` | none | OCR tier for a PDF Workers AI returned nothing for. |
| `isHostAllowed` | public addresses only | SSRF guard run before every origin request. |

A limiter is a function `run => Promise` with `tripCooldown(ms)` and
`dispose()`:

```ts
import type { CreateConcurrencyLimit } from 'website-to-markdown'
```

### Cancellation

Pass `signal`, or run inside `withOperationSignal(signal, run)` so every read
in a job inherits it.

### Crawl snapshots

`withCrawlSnapshot({ mode: 'record' | 'replay', name: 'label/host' }, run, { root })`
records every page and sitemap read under `root` and replays them, so two
benchmark runs read the same site. Never in production.

## Sitemaps

```ts
import { discoverSitemapUrls, fetchRobots, robotsAllows } from 'website-to-markdown/sitemap'

const robots = await fetchRobots('https://example.com')
const pages = await discoverSitemapUrls('https://example.com', robots.sitemaps)
const readable = pages.filter((page) => robotsAllows(robots.rules, page.url))
```

## CLI

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bunx website-to-markdown https://example.com [--no-render]
```
