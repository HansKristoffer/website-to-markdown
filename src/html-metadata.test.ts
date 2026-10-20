import { describe, expect, test } from 'bun:test'
import { decodeHtmlEntities } from './html-entities.js'
import { extractHtmlMetadata } from './html-metadata.js'

const BASE = 'https://tand-klinikken.dk/priser'

describe('extractHtmlMetadata', () => {
	test('reads title, lang, canonical and description from a Danish page', () => {
		const metadata = extractHtmlMetadata(
			`<!DOCTYPE html>
			<html lang="da-DK">
			<head>
				<meta charset="utf-8">
				<title>Priser &ndash; Tandl&aelig;gerne K&oslash;benhavn</title>
				<link rel="stylesheet" href="/style.css">
				<link rel="canonical" href="https://tand-klinikken.dk/priser/">
				<meta name="description" content="Se vores priser p&aring; unders&oslash;gelse og tandrensning.">
				<meta property="og:description" content="Ignoreres">
			</head>
			<body></body></html>`,
			BASE
		)

		expect(metadata.title).toBe('Priser – Tandlægerne København')
		expect(metadata.lang).toBe('da')
		expect(metadata.canonical).toBe('https://tand-klinikken.dk/priser/')
		expect(metadata.metaDescription).toBe(
			'Se vores priser på undersøgelse og tandrensning.'
		)
	})

	test('resolves a relative canonical and falls back to og:description', () => {
		const metadata = extractHtmlMetadata(
			`<html lang='nb'><head><title>Timer</title>
			<link href="../kontakt" rel="canonical">
			<meta property="og:description" content="Åpningstider og kontakt."></head></html>`,
			'https://kiropraktor.com/klinikker/oslo'
		)

		expect(metadata.canonical).toBe('https://kiropraktor.com/kontakt')
		expect(metadata.lang).toBe('nb')
		expect(metadata.metaDescription).toBe('Åpningstider og kontakt.')
	})

	test('returns nulls for a page without metadata', () => {
		const metadata = extractHtmlMetadata('<html><body>Hej</body></html>', BASE)
		expect(metadata).toEqual({
			title: null,
			lang: null,
			canonical: null,
			alternates: [],
			alternateLanguages: {},
			metaDescription: null,
			jsonLd: []
		})
	})

	test('reads hreflang alternates as absolute URLs, skipping x-default', () => {
		// geysier.com: every page declares its EN and DA twin plus a picker.
		const metadata = extractHtmlMetadata(
			`<html lang="en"><head>
			<link rel="alternate" hreflang="en" href="https://geysier.com/about/?ref=a&amp;b=1">
			<link rel="alternate" hreflang="da" href="/da/about/">
			<link rel="alternate" hreflang="x-default" href="https://geysier.com/">
			<link rel="alternate" type="application/rss+xml" href="/feed.xml">
			<link rel="canonical" href="https://geysier.com/about/">
			</head></html>`,
			'https://geysier.com/about/'
		)
		expect(metadata.alternates).toEqual([
			'https://geysier.com/about/?ref=a&b=1',
			'https://geysier.com/da/about/'
		])
		expect(metadata.canonical).toBe('https://geysier.com/about/')
		expect(metadata.alternateLanguages).toEqual({
			'https://geysier.com/about/?ref=a&b=1': 'en',
			'https://geysier.com/da/about/': 'da'
		})
	})

	test('parses JSON-LD blocks and flattens arrays, skipping invalid ones', () => {
		const metadata = extractHtmlMetadata(
			`<html><head>
			<script type="application/ld+json">[{"@type":"LocalBusiness","name":"Saunaway"},{"@type":"OpeningHoursSpecification","opens":"07:30"}]</script>
			<script type="application/ld+json">{"@type":"Organization","name":"Saunaway ApS",}</script>
			<script type="application/ld+json">{"@type":"WebSite","url":"https://saunaway.dk"}</script>
			</head></html>`,
			BASE
		)

		expect(metadata.jsonLd).toEqual([
			{ '@type': 'LocalBusiness', name: 'Saunaway' },
			{ '@type': 'OpeningHoursSpecification', opens: '07:30' },
			{ '@type': 'WebSite', url: 'https://saunaway.dk' }
		])
	})

	test('reads a canonical from a multi-token rel, as WordPress emits it', () => {
		const metadata = extractHtmlMetadata(
			`<html><head><link rel="shortlink canonical" href="/priser"></head></html>`,
			BASE
		)
		expect(metadata.canonical).toBe('https://tand-klinikken.dk/priser')
	})

	test('ignores a lang attribute that is not ISO 639-1', () => {
		expect(extractHtmlMetadata('<html lang="">x</html>', BASE).lang).toBeNull()
		expect(
			extractHtmlMetadata('<html lang="Dansk">x</html>', BASE).lang
		).toBeNull()
	})
})

describe('decodeHtmlEntities', () => {
	test('decodes the named entities Danish and German sites emit', () => {
		expect(decodeHtmlEntities('T&oslash;mrer &amp; Snedker')).toBe(
			'Tømrer & Snedker'
		)
		expect(decodeHtmlEntities('Zahn&auml;rzte &ndash; &Aring;rhus')).toBe(
			'Zahnärzte – Århus'
		)
	})

	test('decodes numeric entities and leaves unknown ones alone', () => {
		expect(decodeHtmlEntities('&#248;l &#x26; brus')).toBe('øl & brus')
		expect(decodeHtmlEntities('100 &notarealentity; kr')).toBe(
			'100 &notarealentity; kr'
		)
	})

	test('does not resolve an entity name through Object.prototype', () => {
		expect(decodeHtmlEntities('Tag &constructor; og &toString;')).toBe(
			'Tag &constructor; og &toString;'
		)
	})
})
