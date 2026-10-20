import { describe, expect, test } from 'bun:test'
import {
	htmlLinks,
	markdownRefs,
	stripDocumentPreamble,
	stripFrontMatter,
	titleFromMarkdown
} from './markdown-refs.js'

const BASE = 'https://hotelhvideklit.dk/vaerelser'

describe('stripFrontMatter', () => {
	test('removes the Workers AI YAML block and keeps its fields', () => {
		const result = stripFrontMatter(
			[
				'---',
				'title: Værelser | Hotel Hvide Klit',
				'description: "Alle værelser har eget bad."',
				'---',
				'',
				'# Værelser',
				'',
				'Husdyr 300 kr.'
			].join('\n')
		)

		expect(result.markdown).toBe('# Værelser\n\nHusdyr 300 kr.')
		expect(result.title).toBe('Værelser | Hotel Hvide Klit')
		expect(result.description).toBe('Alle værelser har eget bad.')
	})

	test('leaves a document without front-matter untouched', () => {
		const markdown = '# Menu\n\n---\n\nEfterret 65 kr.'
		expect(stripFrontMatter(markdown)).toEqual({
			markdown,
			title: null,
			description: null
		})
	})

	test('handles a front-matter block with only a description', () => {
		const result = stripFrontMatter('---\ndescription: Kun tekst\n---\nBrød')
		expect(result.markdown).toBe('Brød')
		expect(result.title).toBeNull()
		expect(result.description).toBe('Kun tekst')
	})
})

describe('titleFromMarkdown', () => {
	test('reads the first H1', () => {
		expect(titleFromMarkdown('Intro\n\n# Åbningstider\n\n# Andet')).toBe(
			'Åbningstider'
		)
		expect(titleFromMarkdown('## Kun H2')).toBeNull()
	})
})

describe('markdownRefs', () => {
	test('resolves links and images to absolute URLs in document order', () => {
		const { links, images } = markdownRefs(
			[
				'[Kontakt](/kontakt) og [Golf](golf) og [Skagen](https://skagen.dk/)',
				'![Terrasse](../billeder/terrasse.jpg)',
				'[![Logo](/logo.svg)](/)'
			].join('\n\n'),
			BASE
		)

		expect(links).toEqual([
			'https://hotelhvideklit.dk/kontakt',
			'https://hotelhvideklit.dk/golf',
			'https://skagen.dk/',
			'https://hotelhvideklit.dk/'
		])
		expect(images).toEqual([
			'https://hotelhvideklit.dk/billeder/terrasse.jpg',
			'https://hotelhvideklit.dk/logo.svg'
		])
	})

	test('skips mailto, tel, javascript and pure fragments', () => {
		const { links } = markdownRefs(
			'[Mail](mailto:info@khtf.dk) [Ring](tel:+4531320004) [Menu](javascript:void(0)) [Top](#top) [Om](/om)',
			BASE
		)
		expect(links).toEqual(['https://hotelhvideklit.dk/om'])
	})

	test('dedupes, keeps titles out of the target and decodes escaped queries', () => {
		const { links, images } = markdownRefs(
			[
				'[Book](/book "Book nu") [Book igen](/book)',
				'![Tag](/GetImage.ashx?image=tag.jpg&amp;width=800)',
				'![Tag igen](/GetImage.ashx?image=tag.jpg&width=800)',
				'<https://reservations.visbook.com/11265?lang=dk>'
			].join('\n\n'),
			BASE
		)

		expect(links).toEqual([
			'https://hotelhvideklit.dk/book',
			'https://reservations.visbook.com/11265?lang=dk'
		])
		expect(images).toEqual([
			'https://hotelhvideklit.dk/GetImage.ashx?image=tag.jpg&width=800'
		])
	})

	test('ignores targets that cannot become an http(s) URL', () => {
		const { links, images } = markdownRefs(
			'[Data](data:text/html,x) [Fil](file:///etc/passwd) ![Inline](data:image/png;base64,AAA)',
			BASE
		)
		expect(links).toEqual([])
		expect(images).toEqual([])
	})
})

describe('htmlLinks', () => {
	test('ignores anchors built inside inline JavaScript', () => {
		// Measured on jakob-tomrer.dk (2026-09-14): a theme script concatenates
		// card links, and 207 of 503 crawl reads were 404s built from it.
		const html = [
			'<a href="/entrepriser">Entrepriser</a>',
			'<script>var card = \'<a href="\'+dipi_permalink+\'">\' + title; el.innerHTML = "<a href=\'"+n+"\'>";</script>',
			'<template><a href="/skabelon">Skabelon</a></template>',
			'<a href="/kontakt">Kontakt</a>'
		].join('')
		expect(htmlLinks(html, 'https://jakob-tomrer.dk/')).toEqual([
			'https://jakob-tomrer.dk/entrepriser',
			'https://jakob-tomrer.dk/kontakt'
		])
	})

	test('finds anchors the markdown conversion loses', () => {
		// Measured on hotelhvideklit.dk (2026-09-01): the homepage HTML carries 16
		// internal hrefs and its markdown 4. The exhibition page - the only place
		// the site states its 95 kr entry price and 10.30-17.00 hours - was
		// reachable through none of the four.
		const html = [
			'<nav><a href="/vaerelser">Værelser</a>',
			'<a href="/galleri/hans-nielsen"><img src="/thumb.jpg" alt=""></a>',
			'<a href=\'/kontakt\' class="x">Kontakt</a></nav>',
			'<a href="/tak?ref=a&amp;b=2">Tak</a>',
			'<a href="mailto:mail@hotelhvideklit.com">Mail</a>',
			'<a href="#main">Spring over</a>'
		].join('\n')

		// `mailto:` and the skip link's same-page `#main` are not pages.
		expect(htmlLinks(html, BASE)).toEqual([
			'https://hotelhvideklit.dk/vaerelser',
			'https://hotelhvideklit.dk/galleri/hans-nielsen',
			'https://hotelhvideklit.dk/kontakt',
			'https://hotelhvideklit.dk/tak?ref=a&b=2'
		])
	})

	test('dedupes and keeps document order', () => {
		const html = '<a href="/a">1</a><a href="/b">2</a><a href="/a">3</a>'
		expect(htmlLinks(html, BASE)).toEqual([
			'https://hotelhvideklit.dk/a',
			'https://hotelhvideklit.dk/b'
		])
	})
})

describe('stripDocumentPreamble', () => {
	test('removes the file name, metadata list, contents heading and page labels Workers AI adds to a PDF', () => {
		const converted = [
			'# Betingelser%2010%2B%20g%C3%A6ster%20%28kort%20version%29.pdf',
			'## Metadata',
			'- PDFFormatVersion=1.7',
			'- Language=da',
			"- CreationDate=D:20260515003540-07'00'",
			'- xmpmm:documentid=uuid:45BAEEC6-03B2-40E8-A445-5FEF559EF31B',
			'',
			'## Contents',
			'### Page 1',
			'',
			'Arrangementer & grupper (10+ gæster)',
			'',
			'- • Fast reservationsgebyr/depositum: kr. 10.000,-',
			'',
			'### Page 2',
			'',
			'Afbestilling skal ske skriftligt.'
		].join('\n')

		expect(stripDocumentPreamble(converted)).toBe(
			[
				'Arrangementer & grupper (10+ gæster)',
				'',
				'- • Fast reservationsgebyr/depositum: kr. 10.000,-',
				'',
				'Afbestilling skal ske skriftligt.'
			].join('\n')
		)
	})

	test('leaves a conversion without the preamble untouched', () => {
		const plain = '# Handelsbetingelser\n\n10+ gæster'
		expect(stripDocumentPreamble(plain)).toBe(plain)
	})

	test('a file whose only heading is the file name keeps its body', () => {
		expect(stripDocumentPreamble('# menu.pdf\n\nStjerneskud 165 kr.')).toBe(
			'Stjerneskud 165 kr.'
		)
	})
})

test('Cloudflare plumbing is never a page to crawl', () => {
	// The e-mail-protection endpoint answers 410, which counted as a page the
	// site failed to deliver and made the whole import "partial".
	const markdown =
		'[\\[email protected\\]](/cdn-cgi/l/email-protection#9ef7) and [Kontakt](/kontakt)'
	expect(markdownRefs(markdown, 'https://lasauna.dk/').links).toEqual([
		'https://lasauna.dk/kontakt'
	])
	expect(
		htmlLinks(
			'<a href="/cdn-cgi/l/email-protection#9ef7">m</a><a href="/kontakt">k</a>',
			'https://lasauna.dk/'
		)
	).toEqual(['https://lasauna.dk/kontakt'])
})
