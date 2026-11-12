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
an `outcome`, and anything unexpected is logged and comes back `transient`.
`convertDocumentBytes` converts an uploaded file (PDF, office files, images);
`urlToMarkdown` is the one-shot form that throws.

| `outcome` | Meaning | `markdown` |
|---|---|---|
| `ok` | Read and converted. | the page |
| `unchanged` | A 304, or the same HTML as the `htmlHash` given. Keep the stored copy. | empty |
| `gone` | 404 or 410. | empty |
| `blocked` | A 4xx other than 429, a bot wall Browser Rendering could not pass, or the SSRF guard refused the URL or a redirect. | empty |
| `transient` | 5xx, a 429 after three paused retries, a network failure, or every conversion tier missed. Try again next run. | empty |
| `unsupported` | Not a URL we read (bad URL, asset, oversized HTML or document). It will not get better on its own. | empty |

`source` says which tier produced the markdown: `content-negotiation` (the
origin served markdown), `workers-ai`, `browser-rendering`, `not-modified`
(for `unchanged`) or `firecrawl-parse` (the `parsePdf` tier, whichever parser
it is). `captureIssue` says why a page is incomplete or missing, when known:

| `captureIssue` | |
|---|---|
| `markdown_limit` | Markdown cut at `MAX_MARKDOWN_CHARS` (300,000). |
| `html_byte_limit` | HTML over 2 MB is not converted; over 4 MB it is not downloaded. |
| `document_byte_limit` | A linked document over 2 MB (PDF: 12 MB). |
| `workers_ai_rate_limited` | Workers AI kept answering 429. |
| `browser_rendering_rate_limited` | Browser Rendering kept answering 429. |
| `render_incomplete` | The page is an app shell and rendering did not fill it. |
| `pdf_page_limit_unverified` | The PDF parser read 60 pages or could not say how many; the rest may be missing. |
| `pdf_extraction_failed` | Workers AI and `parsePdf` both returned nothing. |

### Reading a page again

Pass the last read's `etag` and `lastModified` (sent as conditional headers)
and `htmlHash` (the hash of the HTML served; most origins send no
validators). Identical HTML comes back `unchanged` without a Workers AI call.
The hash includes a conversion version, so after an upgrade that changes the
conversion every page is converted once more.

```ts
const next = await converter.fetchPageAsMarkdown({
	url: stored.url,
	etag: stored.etag,
	lastModified: stored.lastModified,
	htmlHash: stored.htmlHash
})
```

`render: false` skips the Browser Rendering tier. `country: 'DK'` adds
`?country=DK` to the request (not to the page's `url`), which pins a Shopify
store's market when it would otherwise pick one from the server's IP.

Every page's markdown goes through `cleanConvertedMarkdown`: Cloudflare's
obfuscated e-mail links are decoded, JSON-LD code fences and `<?xml`/`<!DOCTYPE`
text removed, and a label glued to its own `mailto:`/`tel:` value split. It is
exported, and idempotent, for markdown stored by an older version.

### Limits

| | |
|---|---|
| HTML converted | 2 MB (read up to 4 MB for links and metadata) |
| Documents | 2 MB, PDFs 12 MB, PDF pages read by `parsePdf` 60 |
| Markdown kept | 300,000 characters |
| Origin request timeout | 30 s, redirects 10 |
| Pages in flight | `URL_TO_MARKDOWN_PAGE_CONCURRENCY` (80), for the caller's own pool |
| Per origin host | 16 in flight; 2 (and 2 starts/s) for 15 minutes after a 429 |
| Workers AI | 24 in flight, 12 starts/s |
| Browser Rendering | 80 in flight, 28 starts/s |
| Sitemaps | 20 files, 20,000 URLs, 10 MB per file; robots.txt 500 KiB |

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
| `isHostAllowed` | public addresses only | SSRF guard run before every origin request and every redirect. |
| `allowLocalhost` | `false` | Let the default guard and `http://` through to `localhost`, `127.0.0.1` and `::1`. Set it outside production for a dev server. |
| `fetch` | global `fetch` | What origin requests go through, behind the guard. Not used for Cloudflare's API. |
| `crawlSnapshot` | none | `{ root, logger? }` for the returned `withCrawlSnapshot`. |

Besides the converters, the factory returns:

- `guardedFetch(url, init?, { maxRedirects? })`: `fetch` behind the
  converter's guard, which follows redirects itself and checks every hop.
  Throws `HostNotAllowedError` when one is refused. Use it for any other
  request to a customer-supplied URL (images, logos, an MCP server).
- `isHostAllowed(hostname)`: the SSRF guard the converter runs, bound to its
  `logger`.
- `withCrawlSnapshot(input, run)`: [crawl snapshots](#crawl-snapshots) under
  `crawlSnapshot.root`. A `null` input just runs `run`.

### SSRF guard

`isHostAllowed(hostname, { logger?, allowLocalhost? })` resolves the name and
refuses it when any address is private, loopback, link-local, CGNAT,
multicast or reserved. An IP literal (`10.0.0.1`, `[fd00::1]`,
`[::ffff:169.254.169.254]`) is judged as written. A failed DNS lookup is let
through so the request reports the real error. Results are cached for 60 s;
DNS rebinding between the check and the connection is not covered.

`guardedFetch(url, init?, { isHostAllowed?, fetch?, maxRedirects? })` is the
standalone form. On a redirect it does what `fetch` does: `Authorization` and
`Cookie` are dropped when the origin changes, and a 303 (or a POST answered
with 301/302) becomes a GET.

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

`website-to-markdown/schema` also has `FETCH_OUTCOMES`, `FETCH_SOURCES` and
`CAPTURE_ISSUES`, the runtime lists behind the types, for narrowing a value
read back from storage: `z.enum(FETCH_OUTCOMES)`.

## Sitemaps

```ts
import { discoverSitemapUrls, fetchRobots, robotsAllows } from 'website-to-markdown/sitemap'

const robots = await fetchRobots('https://example.com')
const pages = await discoverSitemapUrls('https://example.com', robots.sitemaps)
const readable = pages.filter((page) => robotsAllows(robots.rules, page.url))
```

Both read through `guardedFetch` with the default guard and send the browser
user agent. Pass `{ fetch: converter.guardedFetch }` as the last argument to
use the converter's guard, or any `fetch` in tests. Neither throws: a site
without a robots.txt or a sitemap gives `[]`.

## Testing

```ts
import { fakePage, fakeSite } from 'website-to-markdown/testing'

const page = fakePage({ url: 'https://a.dk', markdown: '# A' }) // a complete ok page

const site = fakeSite({
	'https://a.dk': { markdown: '# A', links: ['https://a.dk/kontakt'], etag: 'v1' }
})
await site.fetchPageAsMarkdown({ url: 'https://a.dk', etag: 'v1' }) // unchanged, 304
await site.fetchPageAsMarkdown({ url: 'https://a.dk/x' }) // gone, 404
site.calls // every input, in order
```

`createMemoryConcurrencyLimit` as `createLimit` keeps a test off a shared
limiter, and the `fetch` option keeps it off the network.

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

## Upgrading from 1.x

- Localhost is refused unless you pass `allowLocalhost: true` (1.x allowed it
  whenever `NODE_ENV` was not `production`). For a dev server:
  `createWebsiteToMarkdown({ …, allowLocalhost: process.env.NODE_ENV !== 'production' })`.
  The standalone `isHostAllowed(hostname, logger)` is now
  `isHostAllowed(hostname, { logger, allowLocalhost })`.
- `FetchedPage` has no optional fields: `alternates`, `alternateLanguages`,
  `captureIssue` and `htmlHash` are always set. Build test pages with
  `fakePage` from `website-to-markdown/testing`.
- `captureIssue` is the `CaptureIssue` union instead of `string`. A Browser
  Rendering 429 is `browser_rendering_rate_limited`, no longer
  `workers_ai_rate_limited`.
- Redirects are followed by the library, so every hop passes the guard; a
  redirect to a refused host is `blocked`. Sitemaps and robots.txt go through
  the guard too.
- The conversion version is bumped, so the first read of each page after the
  upgrade converts it again even when its `htmlHash` matches.
