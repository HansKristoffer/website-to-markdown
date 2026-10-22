import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ConvertFileInput } from './client.js'
import type { PdfParser } from './fetch-page.js'
import { CloudflareRateLimitedError } from './rate-limit-retry.js'

type Tier<Input> = (input: Input) => Promise<string | null>

const convertHtmlWithWorkersAi = mock<Tier<{ html: string }>>(async () => null)
const convertFileWithWorkersAi = mock<Tier<ConvertFileInput>>(async () => null)
const renderUrlToMarkdown = mock<Tier<string>>(async () => null)
const parsePdf = mock<PdfParser>(async () => {
	throw new Error('PDF extraction unavailable')
})
const isHostAllowed = mock(async () => true)

mock.module('./client.js', () => ({
	CloudflareRateLimitedError,
	createCloudflareClient: () => ({
		convertHtmlWithWorkersAi,
		convertFileWithWorkersAi,
		renderUrlToMarkdown
	})
}))

const { createWebsiteToMarkdown, MAX_MARKDOWN_CHARS } =
	await import('./fetch-page.js')

/** A fresh converter per test, so no host's pause leaks into the next. */
function converter() {
	return createWebsiteToMarkdown({
		cloudflare: { apiToken: 'token', accountId: 'account' },
		parsePdf,
		isHostAllowed
	})
}

const originalFetch = globalThis.fetch
const originalNodeEnv = process.env.NODE_ENV

type FetchCall = { url: string; headers: Record<string, string> }
let fetchCalls: FetchCall[] = []

/** Respond per requested URL; returning an Error makes the request fail. */
function mockFetch(respond: (url: string) => Response | Error) {
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		const url = String(input)
		fetchCalls.push({
			url,
			headers: (init?.headers ?? {}) as Record<string, string>
		})
		const response = respond(url)
		if (response instanceof Error) throw response
		return response
	}) as unknown as typeof fetch
}

function html(body: string) {
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	})
}

const DANISH_PAGE = `<!DOCTYPE html>
<html lang="da-DK">
	<head>
		<title>T&oslash;mrer i Aarhus | S. Bernhard</title>
		<link rel="canonical" href="/tjenester/tag" />
		<meta name="description" content="Vi laver tage og facader i hele Aarhus." />
		<script type="application/ld+json">
			{"@type":"LocalBusiness","name":"S. Bernhard","telephone":"+45 12 34 56 78"}
		</script>
	</head>
	<body><h1>Tømrer</h1></body>
</html>`

/** Every tier off by default, so each test opts into the one it exercises. */
function setUpTiers() {
	process.env.NODE_ENV = 'development'
	parsePdf.mockReset()
	parsePdf.mockRejectedValue(new Error('PDF extraction unavailable'))
	fetchCalls = []
	for (const tier of [
		convertHtmlWithWorkersAi,
		convertFileWithWorkersAi,
		renderUrlToMarkdown
	]) {
		tier.mockReset()
		tier.mockResolvedValue(null)
	}
	isHostAllowed.mockReset()
	isHostAllowed.mockResolvedValue(true)
}

function tearDownTiers() {
	globalThis.fetch = originalFetch
	if (originalNodeEnv === undefined) delete process.env.NODE_ENV
	else process.env.NODE_ENV = originalNodeEnv
}

describe('fetchPageAsMarkdown', () => {
	beforeEach(setUpTiers)
	afterEach(tearDownTiers)

	test('a market country pins the request, not the page URL', async () => {
		mockFetch(() => html(DANISH_PAGE))
		convertHtmlWithWorkersAi.mockResolvedValue('# Tømrer\n\nVi laver tage.')
		const { fetchPageAsMarkdown } = converter()

		const page = await fetchPageAsMarkdown({
			url: 'https://shop.example/da/products/goodday?variant=1',
			country: 'DK'
		})

		expect(fetchCalls[0]?.url).toBe(
			'https://shop.example/da/products/goodday?variant=1&country=DK'
		)
		expect(page.url).toBe('https://shop.example/da/products/goodday?variant=1')
	})

	test('renders a nonempty application shell but retains short business facts on the fast path', async () => {
		mockFetch(() =>
			html('<html><div id="app"></div><script src="/app.js"></script></html>')
		)
		convertHtmlWithWorkersAi.mockResolvedValue(
			'Loading… Please enable JavaScript'
		)
		renderUrlToMarkdown.mockResolvedValue(
			'# Prices\n\nHaircuts cost 300 kr. Coloring costs 900 kr. Call us to book your appointment.'
		)
		const { fetchPageAsMarkdown } = converter()
		expect(
			(await fetchPageAsMarkdown({ url: 'https://example.com/prices' })).source
		).toBe('browser-rendering')
		renderUrlToMarkdown.mockClear()
		convertHtmlWithWorkersAi.mockResolvedValue(
			'# Opening hours\nMonday 09:00–17:00\nTuesday closed'
		)
		expect(
			(await fetchPageAsMarkdown({ url: 'https://example.com/hours' })).source
		).toBe('workers-ai')
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})
	test('OCR rescues a scanned menu and marks a page-limited parse incomplete', async () => {
		mockFetch(
			() =>
				new Response(new Uint8Array([37, 80, 68, 70]), {
					headers: { 'content-type': 'application/pdf' }
				})
		)
		parsePdf.mockResolvedValue({
			markdown: '# Menu\nSoup 75 kr.',
			numPages: 1
		})
		const { fetchPageAsMarkdown } = converter()
		const result = await fetchPageAsMarkdown({
			url: 'https://example.com/menu.pdf'
		})
		expect(result.source).toBe('firecrawl-parse')
		expect(result.markdown).toContain('75 kr.')
		expect(result.captureIssue).toBeNull()
		parsePdf.mockResolvedValue({
			markdown: '# Menu\nSoup 75 kr.',
			numPages: 60
		})
		expect(
			(await fetchPageAsMarkdown({ url: 'https://example.com/menu.pdf' }))
				.captureIssue
		).toBe('pdf_page_limit_unverified')
	})
	test('PDFs above Workers AI size limits use bounded parsing instead', async () => {
		mockFetch(
			() =>
				new Response(new Uint8Array(3 * 1024 * 1024), {
					headers: { 'content-type': 'application/pdf' }
				})
		)
		parsePdf.mockResolvedValue({
			markdown: '# Menu\nSoup 75 kr.',
			numPages: 2
		})
		const { fetchPageAsMarkdown } = converter()
		expect(
			(await fetchPageAsMarkdown({ url: 'https://example.com/menu.pdf' }))
				.source
		).toBe('firecrawl-parse')
		expect(convertFileWithWorkersAi).not.toHaveBeenCalled()
	})
	test('captures menu images the markdown converter omitted', async () => {
		mockFetch(() =>
			html(
				'<html><h1>Menu</h1><img data-src="/menu.png" src="data:image/gif;base64,AA"></html>'
			)
		)
		convertHtmlWithWorkersAi.mockResolvedValue('# Menu')
		const { fetchPageAsMarkdown } = converter()
		expect(
			(await fetchPageAsMarkdown({ url: 'https://example.com/menu' })).images
		).toEqual(['https://example.com/menu.png'])
	})
	test('an already cancelled run does not fetch the origin or render', async () => {
		mockFetch(() => html('<html>should not fetch</html>'))
		const controller = new AbortController()
		controller.abort()
		const { fetchPageAsMarkdown } = converter()
		expect(
			(
				await fetchPageAsMarkdown({
					url: 'https://example.com',
					signal: controller.signal
				})
			).outcome
		).toBe('transient')
		expect(fetchCalls).toHaveLength(0)
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})
	test('returns markdown from content negotiation with the real status', async () => {
		mockFetch(
			() =>
				new Response('# Åbningstider\n\nMandag-fredag 8-16', {
					status: 200,
					headers: {
						'content-type': 'text/markdown; charset=utf-8',
						etag: 'W/"abc"',
						'last-modified': 'Mon, 01 Sep 2026 08:00:00 GMT'
					}
				})
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://khtf.dk/kontakt' })

		expect(page.outcome).toBe('ok')
		expect(page.source).toBe('content-negotiation')
		expect(page.status).toBe(200)
		expect(page.markdown).toBe('# Åbningstider\n\nMandag-fredag 8-16')
		expect(page.title).toBe('Åbningstider')
		expect(page.etag).toBe('W/"abc"')
		expect(page.lastModified).toBe('Mon, 01 Sep 2026 08:00:00 GMT')
		expect(convertHtmlWithWorkersAi).not.toHaveBeenCalled()
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('reads HTML metadata, strips front-matter and absolutizes refs', async () => {
		mockFetch(() => html(DANISH_PAGE))
		convertHtmlWithWorkersAi.mockResolvedValue(
			[
				'---',
				'title: Tømrer i Aarhus | S. Bernhard',
				'description: Vi laver tage og facader.',
				'---',
				'',
				'# Tømrer',
				'',
				'[Kontakt](/kontakt) · [Ring](tel:12345678) · [Top](#top)',
				'',
				'![Tag](/Admin/Public/GetImage.ashx?image=tag.jpg&amp;width=800)'
			].join('\n')
		)

		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://sbernhard.dk/tjenester/tag'
		})

		expect(page.outcome).toBe('ok')
		expect(page.source).toBe('workers-ai')
		expect(page.markdown.startsWith('# Tømrer')).toBe(true)
		expect(page.title).toBe('Tømrer i Aarhus | S. Bernhard')
		expect(page.lang).toBe('da')
		expect(page.canonical).toBe('https://sbernhard.dk/tjenester/tag')
		expect(page.metaDescription).toBe('Vi laver tage og facader i hele Aarhus.')
		expect(page.jsonLd).toEqual([
			{
				'@type': 'LocalBusiness',
				name: 'S. Bernhard',
				telephone: '+45 12 34 56 78'
			}
		])
		expect(page.links).toEqual(['https://sbernhard.dk/kontakt'])
		expect(page.images).toEqual([
			'https://sbernhard.dk/Admin/Public/GetImage.ashx?image=tag.jpg&width=800'
		])
	})

	test('falls back to the front-matter title when no HTML tier saw the page', async () => {
		mockFetch(() => new Response('blocked', { status: 403 }))
		renderUrlToMarkdown.mockResolvedValue(
			'---\ntitle: Priser\ndescription: Vores priser\n---\n\nKonsultation 560,00 kr.'
		)

		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://kiropraktikicentrum.dk/priser'
		})

		expect(page.outcome).toBe('ok')
		expect(page.source).toBe('browser-rendering')
		expect(page.status).toBe(403)
		expect(page.title).toBe('Priser')
		expect(page.metaDescription).toBe('Vores priser')
		expect(page.markdown).toBe('Konsultation 560,00 kr.')
	})

	test('sends conditional headers and maps 304 to unchanged', async () => {
		mockFetch(() => new Response(null, { status: 304 }))
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://khtf.dk/om-os',
			etag: 'W/"v1"',
			lastModified: 'Mon, 01 Sep 2026 08:00:00 GMT'
		})

		expect(fetchCalls[0]?.headers['If-None-Match']).toBe('W/"v1"')
		expect(fetchCalls[0]?.headers['If-Modified-Since']).toBe(
			'Mon, 01 Sep 2026 08:00:00 GMT'
		)
		expect(page.outcome).toBe('unchanged')
		expect(page.source).toBe('not-modified')
		expect(page.markdown).toBe('')
		expect(page.etag).toBe('W/"v1"')
		expect(page.lastModified).toBe('Mon, 01 Sep 2026 08:00:00 GMT')
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('keeps stored validators only for a 304', async () => {
		mockFetch(
			() =>
				new Response('# Nyt', {
					status: 200,
					headers: { 'content-type': 'text/markdown' }
				})
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://khtf.dk/om-os',
			etag: 'W/"v1"',
			lastModified: 'Mon, 01 Sep 2026 08:00:00 GMT'
		})

		expect(page.outcome).toBe('ok')
		expect(page.etag).toBeNull()
		expect(page.lastModified).toBeNull()
	})

	test('a NUL byte never reaches the page text', async () => {
		// Workers AI kept one inside an image's alt text on a Wix site, and
		// Postgres refuses a string holding one: the whole import failed.
		mockFetch(() => html(DANISH_PAGE))
		convertHtmlWithWorkersAi.mockResolvedValue(
			'# Priser\n\n![M\u0000ännchen](https://static.wix/a.png)\n\nBehandlung 55 CHF'
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://physio.ch/preise' })

		expect(page.markdown).toContain('Behandlung 55 CHF')
		expect(page.markdown).not.toContain('\u0000')
	})

	test('page text is composed Unicode, whatever the site sent', async () => {
		// "Gård" as "a" plus a combining ring: the fact guard read "Broges Ga".
		mockFetch(() => html(DANISH_PAGE))
		convertHtmlWithWorkersAi.mockResolvedValue(
			'# Referencer\n\nHans Broges Ga\u030Ard og Lygtehuset'
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://tomrer.dk/ref' })

		expect(page.markdown).toContain('Hans Broges G\u00E5rd')
	})

	test('maps 404 to gone and 500 to transient without rendering', async () => {
		mockFetch((url) =>
			url.endsWith('/vaek')
				? new Response('nope', { status: 404 })
				: new Response('boom', { status: 500 })
		)
		const { fetchPageAsMarkdown } = converter()

		const gone = await fetchPageAsMarkdown({ url: 'https://khtf.dk/vaek' })
		const transient = await fetchPageAsMarkdown({ url: 'https://khtf.dk/fejl' })

		expect(gone.outcome).toBe('gone')
		expect(gone.status).toBe(404)
		expect(transient.outcome).toBe('transient')
		expect(transient.status).toBe(500)
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('converts what a visitor sees, without closed drawers and templates', async () => {
		mockFetch(() =>
			html(`<html><body>
				<main><h1>GoodDay</h1><p>Pink Grapefruit 195 DKK</p></main>
				<dialog class="theme-drawer__dialog"><template><h2>Your cart is empty</h2></template></dialog>
				<dialog open><p>Choose your country</p></dialog>
				<form method="post" action="/da/contact#ContactForm"><label>Telefon</label><label>Kommentar</label><button>Send us a note</button></form>
				<form action="/cf-api/x"><div class="hide" style="display:none; overflow:hidden;"><label>Url</label><input name="url"></div></form>
				<div style="display: none"><p>Svar: vi åbner kl. 9.</p></div>
			</body></html>`)
		)
		convertHtmlWithWorkersAi.mockResolvedValue(
			'# GoodDay\n\nPink Grapefruit 195 DKK'
		)
		const { fetchPageAsMarkdown } = converter()

		await fetchPageAsMarkdown({ url: 'https://shop.example/products/goodday' })

		const converted = convertHtmlWithWorkersAi.mock.calls[0]?.[0].html ?? ''
		expect(converted).toContain('Pink Grapefruit 195 DKK')
		expect(converted).toContain('Choose your country')
		expect(converted).not.toContain('Your cart is empty')
		expect(converted).not.toContain('Kommentar')
		expect(converted).not.toContain('<label>Url</label>')
		expect(converted).toContain('Svar: vi åbner kl. 9.')
	})

	test('HTML identical to the last read is unchanged and not converted again', async () => {
		mockFetch(() => html(DANISH_PAGE))
		convertHtmlWithWorkersAi.mockResolvedValue('# Tømrer\n\nVi laver tage.')
		const { fetchPageAsMarkdown } = converter()

		const first = await fetchPageAsMarkdown({ url: 'https://sbernhard.dk/tag' })
		convertHtmlWithWorkersAi.mockClear()
		const second = await fetchPageAsMarkdown({
			url: 'https://sbernhard.dk/tag',
			htmlHash: first.htmlHash
		})

		expect(first.htmlHash).toBeTruthy()
		expect(second.outcome).toBe('unchanged')
		expect(convertHtmlWithWorkersAi).not.toHaveBeenCalled()
	})

	test('retries a rate-limited page after the host cools down', async () => {
		let calls = 0
		mockFetch(() => {
			calls++
			return calls === 1
				? new Response('slow down', {
						status: 429,
						headers: { 'retry-after': '0' }
					})
				: html(DANISH_PAGE)
		})
		convertHtmlWithWorkersAi.mockResolvedValue('# Tømrer\n\nVi laver tage.')
		const { fetchPageAsMarkdown } = converter()

		const page = await fetchPageAsMarkdown({ url: 'https://khtf.dk/tag' })

		expect(fetchCalls).toHaveLength(2)
		expect(page.outcome).toBe('ok')
		expect(page.status).toBe(200)
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('a page still refused after the retries is transient, never rendered', async () => {
		mockFetch(
			() =>
				new Response('nope', { status: 429, headers: { 'retry-after': '0' } })
		)
		const { fetchPageAsMarkdown } = converter()

		const page = await fetchPageAsMarkdown({ url: 'https://khtf.dk/priser' })

		// The first request plus three retries, then the stored copy stands.
		expect(fetchCalls).toHaveLength(4)
		expect(page.outcome).toBe('transient')
		expect(page.status).toBe(429)
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('upgrades http to https instead of rejecting the link', async () => {
		mockFetch(
			() =>
				new Response('# Referencer', {
					status: 200,
					headers: { 'content-type': 'text/markdown' }
				})
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'http://sbernhard.dk/referencer'
		})

		expect(fetchCalls[0]?.url).toBe('https://sbernhard.dk/referencer')
		expect(page.url).toBe('https://sbernhard.dk/referencer')
		expect(page.outcome).toBe('ok')
	})

	test('retries the www host when the apex refuses the connection', async () => {
		mockFetch((url) =>
			url.includes('www.')
				? new Response('# Apotek', {
						status: 200,
						headers: { 'content-type': 'text/markdown' }
					})
				: new TypeError('fetch failed')
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://apoteket.dk/apoteker/aalborg-budolfi-apotek'
		})

		expect(fetchCalls.map((call) => call.url)).toEqual([
			'https://apoteket.dk/apoteker/aalborg-budolfi-apotek',
			'https://www.apoteket.dk/apoteker/aalborg-budolfi-apotek'
		])
		expect(page.url).toBe(
			'https://www.apoteket.dk/apoteker/aalborg-budolfi-apotek'
		)
		expect(page.outcome).toBe('ok')
	})

	test('reports transient when both the apex and the www host fail', async () => {
		mockFetch(() => new TypeError('fetch failed'))
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://apoteket.dk/' })

		expect(page.outcome).toBe('transient')
		expect(page.status).toBe(0)
		expect(page.url).toBe('https://apoteket.dk/')
	})

	test('abandons assets on the response content type, not the extension', async () => {
		mockFetch(
			() =>
				new Response('binary', {
					status: 200,
					headers: { 'content-type': 'image/jpeg' }
				})
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://tandlaegen.dk/Admin/Public/GetImage.ashx?image=x'
		})

		expect(page.outcome).toBe('unsupported')
		expect(page.status).toBe(200)
		expect(page.markdown).toBe('')
		expect(convertHtmlWithWorkersAi).not.toHaveBeenCalled()
		expect(convertFileWithWorkersAi).not.toHaveBeenCalled()
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('converts a PDF through Workers AI with the right filename and mime', async () => {
		mockFetch(
			() =>
				new Response(new Uint8Array([37, 80, 68, 70]), {
					status: 200,
					headers: { 'content-type': 'application/pdf' }
				})
		)
		convertFileWithWorkersAi.mockResolvedValue(
			'# Handelsbetingelser\n\n10+ gæster'
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://hotelhvideklit.dk/files/vilkaar.pdf'
		})

		expect(page.outcome).toBe('ok')
		expect(page.source).toBe('workers-ai')
		expect(page.title).toBe('Handelsbetingelser')
		expect(convertFileWithWorkersAi.mock.calls[0]?.[0]).toMatchObject({
			filename: 'vilkaar.pdf',
			mimeType: 'application/pdf'
		})
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('preserves a zero price when converting a linked spreadsheet', async () => {
		const worksheet =
			'<worksheet><sheetData><row r="5"><c r="A5" t="inlineStr"><is><t>Delivery</t></is></c><c r="B5"><v>0</v></c></row></sheetData></worksheet>'
		const bytes = zipSync({
			'xl/worksheets/sheet1.xml': strToU8(worksheet)
		})
		mockFetch(
			() =>
				new Response(bytes, {
					headers: {
						'content-type':
							'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
					}
				})
		)
		convertFileWithWorkersAi.mockResolvedValue(
			'| Service | Price |\n| --- | --- |\n| Delivery | 0 |'
		)
		const { fetchPageAsMarkdown } = converter()

		const page = await fetchPageAsMarkdown({
			url: 'https://example.com/prices.xlsx'
		})

		expect(page.outcome).toBe('ok')
		expect(page.markdown).toContain('| Delivery | 0 |')
		const request = convertFileWithWorkersAi.mock.calls[0]?.[0]
		if (!request || typeof request.body === 'string')
			throw new Error('Spreadsheet conversion must receive workbook bytes')
		const sheet = unzipSync(new Uint8Array(request.body))[
			'xl/worksheets/sheet1.xml'
		]
		if (!sheet) throw new Error('Conversion copy lost its worksheet')
		expect(strFromU8(sheet)).toContain(
			'<c r="B5" t="inlineStr"><is><t>0</t></is></c>'
		)
	})

	test('strips the Workers AI document preamble from a converted PDF', async () => {
		mockFetch(
			() =>
				new Response(new Uint8Array([37, 80, 68, 70]), {
					status: 200,
					headers: { 'content-type': 'application/pdf' }
				})
		)
		convertFileWithWorkersAi.mockResolvedValue(
			'# vilkaar.pdf\n## Metadata\n- PDFFormatVersion=1.7\n- CreationDate=D:20260515003540\n\n## Contents\n### Page 1\n\n# Handelsbetingelser\n\nDepositum kr. 10.000,-'
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://hotelhvideklit.dk/files/vilkaar.pdf'
		})

		expect(page.outcome).toBe('ok')
		expect(page.markdown).toBe('# Handelsbetingelser\n\nDepositum kr. 10.000,-')
		expect(page.title).toBe('Handelsbetingelser')
	})

	test('a scanned PDF reports retryable extraction failure when OCR fails', async () => {
		mockFetch(
			() =>
				new Response(new Uint8Array([37, 80, 68, 70]), {
					status: 200,
					headers: { 'content-type': 'application/pdf' }
				})
		)
		convertFileWithWorkersAi.mockResolvedValue(
			'# scan.pdf\n## Metadata\n- PDFFormatVersion=1.7\n\n## Contents\n### Page 1\n'
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://hotelhvideklit.dk/files/scan.pdf'
		})

		expect(page.outcome).toBe('transient')
		expect(page.captureIssue).toBe('pdf_extraction_failed')
		expect(page.markdown).toBe('')
	})

	test('refuses a host that resolves to a private address without fetching', async () => {
		mockFetch(() => new Response('secret', { status: 200 }))
		isHostAllowed.mockResolvedValue(false)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://internal.acme.dk' })

		expect(page.outcome).toBe('blocked')
		expect(page.status).toBe(0)
		expect(fetchCalls).toEqual([])
	})

	test('abandons an HTML body over the size cap instead of retrying it', async () => {
		mockFetch(() =>
			html(`<html><body>${'x'.repeat(2 * 1024 * 1024)}</body></html>`)
		)
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://kirohuset.dk/upload'
		})

		// A 6 MB upload is the same 6 MB next run, so it must not look transient.
		expect(page.outcome).toBe('unsupported')
		expect(convertHtmlWithWorkersAi).not.toHaveBeenCalled()
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('converts a text/html body that does not start with a doctype', async () => {
		mockFetch(
			() =>
				new Response('<!-- built by Umbraco -->\n<div>Åbningstider</div>', {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' }
				})
		)
		convertHtmlWithWorkersAi.mockResolvedValue('# Åbningstider')
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({
			url: 'https://horsenssvaneapotek.dk/'
		})

		expect(page.source).toBe('workers-ai')
		expect(page.markdown).toBe('# Åbningstider')
	})

	test('does not spend a render on a 4xx that is not a bot wall', async () => {
		mockFetch(() => new Response('bad request', { status: 400 }))
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://khtf.dk/soeg' })

		expect(page.outcome).toBe('blocked')
		expect(page.status).toBe(400)
		expect(renderUrlToMarkdown).not.toHaveBeenCalled()
	})

	test('resolves refs against the redirect target, not the requested URL', async () => {
		mockFetch(() => {
			const response = new Response('[Priser](/priser)', {
				status: 200,
				headers: { 'content-type': 'text/markdown' }
			})
			// What a followed redirect leaves behind; `Response` has no init for it.
			Object.defineProperty(response, 'url', {
				value: 'https://www.dentist.dk/da/om-os'
			})
			return response
		})
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://dentist.dk/om-os' })

		expect(page.finalUrl).toBe('https://www.dentist.dk/da/om-os')
		expect(page.links).toEqual(['https://www.dentist.dk/priser'])
	})

	test('caps stored markdown', async () => {
		mockFetch(() => html('<html><body>big</body></html>'))
		convertHtmlWithWorkersAi.mockResolvedValue('a'.repeat(400_000))
		const { fetchPageAsMarkdown } = converter()
		const page = await fetchPageAsMarkdown({ url: 'https://cerix.dk/priser' })

		expect(page.markdown.length).toBe(MAX_MARKDOWN_CHARS)
	})

	test('treats an unusable URL as unsupported instead of throwing', async () => {
		const { fetchPageAsMarkdown } = converter()
		expect((await fetchPageAsMarkdown({ url: 'not a url' })).outcome).toBe(
			'unsupported'
		)
		expect(
			(await fetchPageAsMarkdown({ url: 'ftp://khtf.dk/file' })).outcome
		).toBe('unsupported')
		expect(fetchCalls).toEqual([])
	})
})

describe('urlToMarkdown', () => {
	beforeEach(setUpTiers)
	afterEach(tearDownTiers)

	test('urlToMarkdown returns markdown and source, and throws on a gone page', async () => {
		mockFetch((url) =>
			url.endsWith('/ok')
				? new Response('# Hej', {
						status: 200,
						headers: { 'content-type': 'text/markdown' }
					})
				: new Response('gone', { status: 410 })
		)
		const { urlToMarkdown } = converter()

		expect(await urlToMarkdown('https://khtf.dk/ok')).toEqual({
			markdown: '# Hej',
			source: 'content-negotiation'
		})
		await expect(urlToMarkdown('https://khtf.dk/gone')).rejects.toThrow(
			'Failed to convert URL to markdown'
		)
	})
})
