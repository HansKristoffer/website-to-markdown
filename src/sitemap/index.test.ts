import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
	discoverSitemapUrls,
	fetchRobots,
	parseRobotsRules,
	robotsAllows,
	normalizeSitemapUrl,
	parseSitemapXml
} from './index.js'

const originalFetch = globalThis.fetch

type Route = { body: string; status?: number; contentType?: string }

/** Serves the routes given; everything else answers 404, like a real host. */
function mockRoutes(routes: Record<string, Route | Error>) {
	globalThis.fetch = mock(async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input.toString()
		const route = routes[url]
		if (route instanceof Error) throw route
		if (!route) return new Response('not found', { status: 404 })
		return new Response(route.body, {
			status: route.status ?? 200,
			headers: { 'content-type': route.contentType ?? 'application/xml' }
		})
	}) as unknown as typeof fetch
}

function urlset(...urls: string[]) {
	return `<?xml version="1.0"?><urlset>${urls
		.map((url) => `<url><loc>${url}</loc></url>`)
		.join('')}</urlset>`
}

afterEach(() => {
	globalThis.fetch = originalFetch
})

describe('parseSitemapXml', () => {
	test('reads urls with lastmod from a urlset', () => {
		const { pages, nested } = parseSitemapXml(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://acme.dk/kontakt</loc><lastmod>2026-08-01T10:00:00+00:00</lastmod></url>
  <url><loc>https://acme.dk/priser?a=1&amp;b=2</loc></url>
</urlset>`)
		expect(pages).toEqual([
			{ url: 'https://acme.dk/kontakt', lastmod: '2026-08-01T10:00:00+00:00' },
			{ url: 'https://acme.dk/priser?a=1&b=2', lastmod: null }
		])
		expect(nested).toEqual([])
	})

	test('follows a sitemap index', () => {
		const { pages, nested } = parseSitemapXml(`<sitemapindex>
  <sitemap><loc>https://acme.dk/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://acme.dk/post-sitemap.xml</loc></sitemap>
</sitemapindex>`)
		expect(pages).toEqual([])
		expect(nested).toEqual([
			'https://acme.dk/page-sitemap.xml',
			'https://acme.dk/post-sitemap.xml'
		])
	})
})

describe('robots rules', () => {
	const rules = parseRobotsRules(`# Shopify storefront
User-agent: *
Allow: /
Disallow: /cart/
Disallow: /*/cart/
Disallow: /collections/*sort_by*
Allow: /collections/checkout
Disallow: /checkout

User-agent: AhrefsBot
Disallow: /
`)

	test('the wildcard group decides, a named crawler group does not', () => {
		expect(robotsAllows(rules, 'https://shop.dk/products/goodday')).toBe(true)
		expect(
			robotsAllows(rules, 'https://shop.dk/cart/add?id=1&quantity=1')
		).toBe(false)
		expect(robotsAllows(rules, 'https://shop.dk/da/cart/add?id=1')).toBe(false)
		expect(
			robotsAllows(rules, 'https://shop.dk/collections/all?sort_by=price')
		).toBe(false)
	})

	test('the longest match wins and an allow wins a tie', () => {
		expect(robotsAllows(rules, 'https://shop.dk/checkout')).toBe(false)
		expect(robotsAllows(rules, 'https://shop.dk/collections/checkout')).toBe(
			true
		)
		expect(
			robotsAllows(
				parseRobotsRules('User-agent: *\nDisallow: /a\nAllow: /a'),
				'https://x.dk/a'
			)
		).toBe(true)
	})

	test('an empty disallow and a missing file allow everything', () => {
		expect(
			robotsAllows(
				parseRobotsRules('User-agent: *\nDisallow:'),
				'https://x.dk/cart/'
			)
		).toBe(true)
		expect(robotsAllows([], 'https://x.dk/cart/')).toBe(true)
	})
})

describe('normalizeSitemapUrl', () => {
	test('drops trailing slashes and fragments', () => {
		expect(normalizeSitemapUrl('https://acme.dk/kontakt/#main')).toBe(
			'https://acme.dk/kontakt'
		)
		expect(normalizeSitemapUrl('https://acme.dk/')).toBe('https://acme.dk')
	})
})

describe('fetchRobots', () => {
	test('reads every Sitemap line, case-insensitive and relative-aware', async () => {
		mockRoutes({
			'https://hotelhvideklit.dk/robots.txt': {
				contentType: 'text/plain',
				body: [
					'User-agent: *',
					'Disallow: /admin',
					'Sitemap: https://hotelhvideklit.dk/sitemap.xml',
					'  sitemap:https://hotelhvideklit.dk/news-sitemap.xml',
					'SITEMAP: /da/sitemap.xml',
					''
				].join('\n')
			}
		})
		expect(
			(await fetchRobots('https://hotelhvideklit.dk/kontakt')).sitemaps
		).toEqual([
			'https://hotelhvideklit.dk/sitemap.xml',
			'https://hotelhvideklit.dk/news-sitemap.xml',
			'https://hotelhvideklit.dk/da/sitemap.xml'
		])
	})

	test('an HTML body, a 404 or a network error means "no sitemaps"', async () => {
		mockRoutes({
			'https://lasauna.dk/robots.txt': {
				contentType: 'text/html',
				body: '<html><body>Siden findes ikke</body></html>'
			}
		})
		expect((await fetchRobots('https://lasauna.dk')).sitemaps).toEqual([])

		mockRoutes({})
		expect((await fetchRobots('https://lasauna.dk')).sitemaps).toEqual([])

		mockRoutes({
			'https://lasauna.dk/robots.txt': new Error('TLS handshake failed')
		})
		expect((await fetchRobots('https://lasauna.dk')).sitemaps).toEqual([])
	})

	test('ignores unfetchable lines without losing the others', async () => {
		mockRoutes({
			'https://khtf.dk/robots.txt': {
				contentType: 'text/plain',
				body: [
					'Sitemap: http://[unparseable',
					'Sitemap: ftp://khtf.dk/old-sitemap.xml',
					'Sitemap: https://khtf.dk/wp-sitemap.xml'
				].join('\n')
			}
		})
		expect((await fetchRobots('https://khtf.dk')).sitemaps).toEqual([
			'https://khtf.dk/wp-sitemap.xml'
		])
	})
})

describe('discoverSitemapUrls', () => {
	const discover = async (websiteUrl: string) =>
		discoverSitemapUrls(websiteUrl, (await fetchRobots(websiteUrl)).sitemaps)

	test('prefers the robots-declared sitemaps and reads all of them', async () => {
		mockRoutes({
			'https://khtf.dk/robots.txt': {
				contentType: 'text/plain',
				body: 'Sitemap: https://khtf.dk/wp-sitemap-posts-page-1.xml\nSitemap: https://khtf.dk/wp-sitemap-posts-post-1.xml'
			},
			'https://khtf.dk/wp-sitemap-posts-page-1.xml': {
				body: urlset('https://khtf.dk/', 'https://khtf.dk/kontakt')
			},
			'https://khtf.dk/wp-sitemap-posts-post-1.xml': {
				body: `<urlset><url><loc>https://khtf.dk/blog/tagrenovering</loc><lastmod>2026-07-04</lastmod></url></urlset>`
			},
			// Would be found by the conventional fallback - must not be read.
			'https://khtf.dk/sitemap.xml': {
				body: urlset('https://khtf.dk/skal-ikke-med')
			}
		})
		expect(await discover('https://khtf.dk')).toEqual([
			{ url: 'https://khtf.dk/', lastmod: null },
			{ url: 'https://khtf.dk/kontakt', lastmod: null },
			{ url: 'https://khtf.dk/blog/tagrenovering', lastmod: '2026-07-04' }
		])
	})

	test('falls back through the conventional roots in order', async () => {
		mockRoutes({
			// No robots.txt, no /sitemap.xml, and an empty /sitemap_index.xml.
			'https://colosseumtand.dk/sitemap_index.xml': {
				body: '<urlset></urlset>'
			},
			'https://colosseumtand.dk/wp-sitemap.xml': {
				body: urlset(
					'https://colosseumtand.dk/klinikker/aarhus',
					'https://colosseumtand.dk/priser'
				)
			}
		})
		expect(await discover('https://colosseumtand.dk')).toEqual([
			{ url: 'https://colosseumtand.dk/klinikker/aarhus', lastmod: null },
			{ url: 'https://colosseumtand.dk/priser', lastmod: null }
		])
	})

	test('follows nested sitemap indexes and dedupes across files', async () => {
		mockRoutes({
			'https://cerix.dk/sitemap.xml': {
				body: `<sitemapindex>
					<sitemap><loc>https://cerix.dk/page-sitemap.xml</loc></sitemap>
					<sitemap><loc>https://cerix.dk/post-sitemap.xml</loc></sitemap>
				</sitemapindex>`
			},
			'https://cerix.dk/page-sitemap.xml': {
				body: urlset('https://cerix.dk/priser', 'https://cerix.dk/personale')
			},
			'https://cerix.dk/post-sitemap.xml': {
				// Trailing-slash variant of a page the first file already listed.
				body: urlset(
					'https://cerix.dk/priser/',
					'https://cerix.dk/blog/hudpleje'
				)
			}
		})
		expect(await discover('https://cerix.dk')).toEqual([
			{ url: 'https://cerix.dk/priser', lastmod: null },
			{ url: 'https://cerix.dk/personale', lastmod: null },
			{ url: 'https://cerix.dk/blog/hudpleje', lastmod: null }
		])
	})

	test('falls back to the conventional roots when robots.txt lies', async () => {
		mockRoutes({
			'https://sauna85.dk/robots.txt': {
				contentType: 'text/plain',
				// Left behind by a previous CMS: the file is gone.
				body: 'Sitemap: https://sauna85.dk/sitemap-index.xml'
			},
			'https://sauna85.dk/sitemap.xml': {
				body: urlset(
					'https://sauna85.dk/priser',
					'https://sauna85.dk/en/prices'
				)
			}
		})
		expect(await discover('https://sauna85.dk')).toEqual([
			{ url: 'https://sauna85.dk/priser', lastmod: null },
			{ url: 'https://sauna85.dk/en/prices', lastmod: null }
		])
	})

	test('stops after 20 sitemap files so a huge index cannot run away', async () => {
		const children = Array.from(
			{ length: 30 },
			(_, i) => `https://tandlaegen.dk/sitemap-${i + 1}.xml`
		)
		mockRoutes({
			'https://tandlaegen.dk/sitemap.xml': {
				body: `<sitemapindex>${children
					.map((url) => `<sitemap><loc>${url}</loc></sitemap>`)
					.join('')}</sitemapindex>`
			},
			...Object.fromEntries(
				children.map((url, i) => [
					url,
					{ body: urlset(`https://tandlaegen.dk/klinik-${i + 1}`) }
				])
			)
		})
		const pages = await discover('https://tandlaegen.dk')
		// The index itself spends one of the 20 files.
		expect(pages.map((page) => page.url)).toEqual(
			Array.from(
				{ length: 19 },
				(_, i) => `https://tandlaegen.dk/klinik-${i + 1}`
			)
		)
	})

	test('a site without any sitemap is empty, not an error', async () => {
		mockRoutes({
			'https://kiropraktikicentrum.dk/robots.txt': {
				contentType: 'text/plain',
				body: 'User-agent: *\nDisallow:'
			},
			// A CMS that renders its 404 page with a 200 for missing files.
			'https://kiropraktikicentrum.dk/sitemap.xml': {
				contentType: 'text/html',
				body: '<html><body>404</body></html>'
			},
			'https://kiropraktikicentrum.dk/sitemap_index.xml': new Error(
				'connection reset'
			)
		})
		expect(await discover('https://kiropraktikicentrum.dk')).toEqual([])
	})

	test('an unparseable website url yields no urls and no fetch', async () => {
		const fetchMock = mock(async () => new Response('', { status: 200 }))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		expect(await discover('ikke en url')).toEqual([])
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
