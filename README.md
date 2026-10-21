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
| `reportTimeouts` | `true` | `false` keeps Workers AI timeouts from `onApiError`; the page falls through to the next tier anyway. |
| `logger` | silent | `{ info, warn }` |
| `parsePdf` | none | OCR tier for a PDF Workers AI returned nothing for. |
| `isHostAllowed` | public addresses only | SSRF guard run before every origin request. |
| `crawlSnapshot` | none | `{ root, logger? }` for the returned `withCrawlSnapshot`. |

Besides the converters, the factory returns:

- `isHostAllowed(hostname)`: the SSRF guard the converter runs, bound to its
  `logger`. Use it for any other fetch of a customer-supplied URL.
- `withCrawlSnapshot(input, run)`: [crawl snapshots](#crawl-snapshots) under
  `crawlSnapshot.root`. A `null` input just runs `run`.

A limiter is a function `run => Promise` with `tripCooldown(ms)` and
`dispose()`:

```ts
import type { CreateConcurrencyLimit } from 'website-to-markdown'
```

`hanzio/redis` has one that shares the pools across processes; bind its
`send`:

```ts
import { createRedisConcurrencyLimit } from 'hanzio/redis'

const converter = createWebsiteToMarkdown({
	cloudflare,
	createLimit: (options) =>
		createRedisConcurrencyLimit({
			...options,
			send: (command, args) => redis.send(command, args)
		})
})
```

`options.metricLabel` names the pool a per-host limiter belongs to; report
metrics under it rather than under `key`, which is one per customer host.

### Cancellation

Pass `signal`, or run inside `withOperationSignal(signal, run)` so every read
in a job inherits it.

### Crawl snapshots

`withCrawlSnapshot({ mode: 'record' | 'replay', name: 'label/host' }, run, { root })`
records every page and sitemap read under `root` and replays them, so two
benchmark runs read the same site. Never in production. Pass
`crawlSnapshot: { root }` to the factory to get it bound as
`converter.withCrawlSnapshot(input, run)`.

A shared schema can check a name without importing the runtime:

```ts
import { CRAWL_SNAPSHOT_NAME_PATTERN } from 'website-to-markdown/schema'

const CrawlSnapshotInput = z.object({
	mode: z.enum(['record', 'replay']),
	name: z.string().regex(CRAWL_SNAPSHOT_NAME_PATTERN)
})
```

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

`--env-file <path>` reads the two variables from a dotenv file instead; a
variable already in the environment wins. With a secrets manager, export to a
file or run the CLI under it:

```sh
infisical export --format=dotenv > .env.cloudflare
bunx website-to-markdown https://example.com --env-file .env.cloudflare

infisical run -- bunx website-to-markdown https://example.com
```
