import { describe, expect, test } from 'bun:test'
import { localHtmlToMarkdown } from './local-html-to-markdown.js'

function encodeCfEmail(email: string, key = 0x2a) {
	return (
		key.toString(16).padStart(2, '0') +
		[...email]
			.map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
			.join('')
	)
}

describe('localHtmlToMarkdown', () => {
	test('converts headings, paragraphs, lists and GFM tables cleanly', () => {
		const html = `
			<html>
				<head><title>Priser</title><style>.x{color:red}</style></head>
				<body>
					<h1>Priser og behandlinger</h1>
					<p>Alle priser er inkl. moms.</p>
					<table>
						<thead><tr><th>Behandling</th><th>Varighed</th><th>Pris</th></tr></thead>
						<tbody>
							<tr><td>Kiropraktik</td><td>30 min</td><td>595 kr.</td></tr>
							<tr><td>Massage</td><td>45 min</td><td>495 kr.</td></tr>
						</tbody>
					</table>
					<ul>
						<li>Gratis parkering</li>
						<li>Afbud senest 24 timer før</li>
					</ul>
					<ol start="3">
						<li>Tredje punkt</li>
						<li>Fjerde punkt</li>
					</ol>
				</body>
			</html>
		`
		const md = localHtmlToMarkdown(html, 'https://example.dk/priser')
		expect(md).toContain('# Priser og behandlinger')
		expect(md).toContain('Alle priser er inkl. moms.')
		expect(md).toContain('| Behandling | Varighed | Pris |')
		expect(md).toContain('| --- | --- | --- |')
		expect(md).toContain('| Kiropraktik | 30 min | 595 kr. |')
		expect(md).toContain('- Gratis parkering')
		expect(md).toContain('- Afbud senest 24 timer før')
		expect(md).toContain('3. Tredje punkt\n4. Fjerde punkt')
		expect(md).not.toContain('color:red')
	})

	test('separates adjacent inline elements so flex/grid card layouts never glue words', () => {
		const html = `
			<div>
				<a href="/lokationer/odense"><span>Odense</span><span>Banebyen</span><span>Rugårdsvej 5, 5000 Odense</span></a>
				<div class="rule"><span>01</span><span>Alkoholfri zone</span></div>
				<div class="product"><span>GoodDay™ 500g</span><span>395 DKK</span></div>
				<a href="mailto:hello@geysier.com"><span>Sales</span><span>hello@geysier.com</span></a>
				<div class="meta"><span>Levering</span><strong>gratis</strong></div>
				<div class="sale"><del>495 DKK</del><span>395 DKK</span></div>
				<div class="logos"><img src="/vestas.svg" alt="Vestas"><img src="/orsted.svg" alt="Ørsted"></div>
			</div>
		`
		const md = localHtmlToMarkdown(html, 'https://example.dk/')
		expect(md).toContain('Odense Banebyen Rugårdsvej 5, 5000 Odense')
		expect(md).toContain('01 Alkoholfri zone')
		expect(md).toContain('GoodDay™ 500g 395 DKK')
		expect(md).toContain('[Sales hello@geysier.com](mailto:hello@geysier.com)')
		expect(md).toContain('Levering **gratis**')
		expect(md).toContain('~~495 DKK~~ 395 DKK')
		expect(md).toContain(
			'![Vestas](https://example.dk/vestas.svg) ![Ørsted](https://example.dk/orsted.svg)'
		)
	})

	test('keeps typographic inline wrappers and punctuation natural without extra spaces', () => {
		const html = `
			<p>This is un<strong>believ</strong>able and <em>pre</em>fixed.</p>
			<p><strong>Hello</strong>, world! (<em>optional</em>)</p>
			<p><strong>Hello </strong>world and Click <strong> here </strong> now.</p>
			<p><strong><strong>Nested bold</strong></strong></p>
		`
		const md = localHtmlToMarkdown(html, 'https://example.com/')
		expect(md).toContain('This is un**believ**able and *pre*fixed.')
		expect(md).toContain('**Hello**, world! (*optional*)')
		expect(md).toContain('**Hello** world and Click **here** now.')
		expect(md).toContain('**Nested bold**')
		expect(md).not.toContain('****')
	})

	test('preserves block structure when an anchor wraps a whole card', () => {
		const html = `
			<a href="/vaerelser/junior-suite">
				<h3>Junior Suite</h3>
				<p>Plads til 3 gæster.</p>
				<p>1.895 kr. pr. nat</p>
			</a>
			<a href="/vaerelser/standard">
				<div><img src="/standard.jpg" alt="Standard"></div>
				<h3>Standard</h3>
				<p>Plads til 2 gæster.</p>
			</a>
			<a href="/tilbud">
				<p>Weekendophold</p>
				<p>Inkl. morgenmad</p>
			</a>
			<a href="/galleri">
				<div><img src="/gallery.jpg" alt="Galleri"></div>
			</a>
		`
		const md = localHtmlToMarkdown(html, 'https://hotel.dk/vaerelser')
		expect(md).toContain(
			'### [Junior Suite](https://hotel.dk/vaerelser/junior-suite)\n\nPlads til 3 gæster.\n\n1.895 kr. pr. nat'
		)
		expect(md).toContain(
			'![Standard](https://hotel.dk/standard.jpg)\n\n### [Standard](https://hotel.dk/vaerelser/standard)\n\nPlads til 2 gæster.'
		)
		expect(md).toContain(
			'[Weekendophold](https://hotel.dk/tilbud)\n\nInkl. morgenmad'
		)
		expect(md).toContain(
			'[![Galleri](https://hotel.dk/gallery.jpg)](https://hotel.dk/galleri)'
		)
	})

	test('handles uneven tables, pipes, internal newlines, nested tables and single-column layout tables', () => {
		const html = `
			<table>
				<caption>Priser 2026</caption>
				<tr><th>Ydelse</th><th>Note</th><th>Pris</th></tr>
				<tr><td>A | B</td><td><p>Linje 1</p><p>Linje 2</p></td></tr>
				<tr><td>C</td><td>Med<br>linjeskift</td><td>250 kr.</td></tr>
			</table>
			<table>
				<tr><td>Layout afsnit 1</td></tr>
				<tr><td>Layout afsnit 2</td></tr>
			</table>
			<table>
				<tr><th>Outer 1</th><th>Outer 2</th></tr>
				<tr>
					<td>Main</td>
					<td><table><tr><td>Inner A</td><td>Inner B</td></tr></table></td>
				</tr>
			</table>
		`
		const md = localHtmlToMarkdown(html, 'https://example.dk/')
		expect(md).toContain('**Priser 2026**')
		expect(md).toContain('| Ydelse | Note | Pris |')
		expect(md).toContain('| --- | --- | --- |')
		expect(md).toContain('| A \\| B | Linje 1 Linje 2 |  |')
		expect(md).toContain('| C | Med linjeskift | 250 kr. |')
		expect(md).toContain('Layout afsnit 1\n\nLayout afsnit 2')
		expect(md).toContain('| Outer 1 | Outer 2 |')
	})

	test('strips hidden UI, closed dialogs, contact forms, selects, scripts, svgs and honeypot labels while keeping collapsed FAQs', () => {
		const html = `
			<body>
				<template><p>Your cart is empty</p></template>
				<dialog><p>Search overlay</p></dialog>
				<dialog open><p>Åben besked</p></dialog>
				<form action="/contact"><label>Navn</label><button>Send</button></form>
				<form action="/da/contact#ContactForm"><label>Telefon</label><button>Ring</button></form>
				<select>
					<optgroup label="Europe">
						<option>Denmark (DKK)</option>
						<option>Germany (EUR)</option>
					</optgroup>
					<option>Afghanistan (AFN)</option>
				</select>
				<textarea>Draft comment</textarea>
				<input type="text" value="Hidden input" />
				<svg><title>Icon</title><text>SVG text</text></svg>
				<script>var x = "<p>Leaked script</p>";</script>
				<noscript><p>Enable JS pixel</p></noscript>
				<iframe src="https://ads.example/frame"><p>Iframe fallback</p></iframe>
				<div style="display:none"><label>HoneypotField</label><p>Svaret på FAQ er 14 dage.</p></div>
				<label style="display: none">DirectHiddenLabel</label>
				<p>Kontakt os på 31 32 00 04.</p>
			</body>
		`
		const md = localHtmlToMarkdown(html, 'https://shop.dk/')
		expect(md).not.toContain('Your cart is empty')
		expect(md).not.toContain('Search overlay')
		expect(md).toContain('Åben besked')
		expect(md).not.toContain('Navn')
		expect(md).not.toContain('Telefon')
		expect(md).not.toContain('Afghanistan')
		expect(md).not.toContain('Denmark (DKK)')
		expect(md).not.toContain('Draft comment')
		expect(md).not.toContain('SVG text')
		expect(md).not.toContain('Leaked script')
		expect(md).not.toContain('Enable JS pixel')
		expect(md).not.toContain('Iframe fallback')
		expect(md).not.toContain('HoneypotField')
		expect(md).not.toContain('DirectHiddenLabel')
		expect(md).toContain('Svaret på FAQ er 14 dage.')
		expect(md).toContain('Kontakt os på 31 32 00 04.')
	})

	test('decodes Cloudflare email obfuscation across span, anchor and /cdn-cgi links', () => {
		const hex = encodeCfEmail('info@lasauna.dk')
		const salesHex = encodeCfEmail('sales@geysier.com', 0x5a)
		const html = `
			<p>Skriv til <span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></p>
			<p>Direkte: <a data-cfemail="${hex}">[email&#160;protected]</a></p>
			<p>Hash: <a href="/cdn-cgi/l/email-protection#${hex}">[email&#160;protected]</a></p>
			<p>Wrapped: <a href="/cdn-cgi/l/email-protection"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a></p>
			<p>Labeled: <a href="/cdn-cgi/l/email-protection"><span>Sales</span><span class="__cf_email__" data-cfemail="${salesHex}">[email&#160;protected]</span></a></p>
		`
		const md = localHtmlToMarkdown(html, 'https://lasauna.dk/')
		expect(md).toContain('Skriv til [info@lasauna.dk](mailto:info@lasauna.dk)')
		expect(md).toContain('Direkte: [info@lasauna.dk](mailto:info@lasauna.dk)')
		expect(md).toContain('Hash: [info@lasauna.dk](mailto:info@lasauna.dk)')
		expect(md).toContain('Wrapped: [info@lasauna.dk](mailto:info@lasauna.dk)')
		expect(md).toContain(
			'Labeled: [Sales sales@geysier.com](mailto:sales@geysier.com)'
		)
		expect(md).not.toContain('/cdn-cgi/')
	})

	test('does not backslash-escape ordinals', () => {
		const html =
			'<p>Åbent 28.-30. april og grundlagt i 1984. Besøg os på 1. sal.</p>'
		const md = localHtmlToMarkdown(html, 'https://hotel.dk/')
		expect(md).toBe(
			'Åbent 28.-30. april og grundlagt i 1984. Besøg os på 1. sal.'
		)
	})

	test('renders pre/code blocks cleanly without literal code tags or double entity decoding', () => {
		const html = `
			<p>Brug <code>a &lt; b</code> og <code>foo \`bar\` baz</code>.</p>
			<pre><code class="language-ts">const x = "&amp;lt;div&amp;gt;";\nconsole.log(x);</code></pre>
		`
		const md = localHtmlToMarkdown(html)
		expect(md).toContain('`a < b`')
		expect(md).toContain('``foo `bar` baz``')
		expect(md).toContain('```\nconst x = "&lt;div&gt;";\nconsole.log(x);\n```')
		expect(md).not.toContain('<code')
	})

	test('resolves lazy image attributes when src is a data URI placeholder', () => {
		const html =
			'<p><img src="data:image/gif;base64,AA" data-src="/menu (2026).png" alt="Menu"></p>'
		const md = localHtmlToMarkdown(html, 'https://example.dk/')
		expect(md).toBe('![Menu](https://example.dk/menu%20%282026%29.png)')
	})

	test('decodes HTML5 entities, strips soft hyphens and NUL bytes, and normalizes Unicode NFC', () => {
		const html =
			'<p>Kiro&shy;praktik &rarr; Hans Broges Ga\u030Ard 100&nbsp;kr.\u0000</p>'
		const md = localHtmlToMarkdown(html)
		expect(md).toBe('Kiropraktik → Hans Broges G\u00e5rd 100 kr.')
		expect(md).not.toContain('\u0000')
		expect(md).not.toContain('\u00ad')
	})
})
