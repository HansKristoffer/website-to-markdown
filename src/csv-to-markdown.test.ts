import { describe, expect, test } from 'bun:test'
import { csvToMarkdownTable } from './csv-to-markdown.js'

describe('csvToMarkdownTable', () => {
	test('converts comma-delimited CSV with quoted cells and escaped quotes into a GFM table', () => {
		const csv = [
			'service,price,currency,condition',
			'"Sensor inspection",300,DKK,"Includes ""basic"" inspection only"',
			'S7 repair,900,DKK,"Parts charged separately, excl. VAT"'
		].join('\n')
		expect(csvToMarkdownTable(csv)).toBe(
			[
				'| service | price | currency | condition |',
				'| --- | --- | --- | --- |',
				'| Sensor inspection | 300 | DKK | Includes "basic" inspection only |',
				'| S7 repair | 900 | DKK | Parts charged separately, excl. VAT |'
			].join('\n')
		)
	})

	test('supports semicolon-delimited European CSV files including quoted commas in headers', () => {
		const csv =
			'\uFEFF"Produkt, type";Pris;Valuta\r\n"Klipning, dame";450,00;DKK\r\nFarvning;895,00;DKK\r\n'
		expect(csvToMarkdownTable(csv)).toBe(
			[
				'| Produkt, type | Pris | Valuta |',
				'| --- | --- | --- |',
				'| Klipning, dame | 450,00 | DKK |',
				'| Farvning | 895,00 | DKK |'
			].join('\n')
		)
	})

	test('preserves numeric zeros verbatim', () => {
		const csv = [
			'Item,Fee,Tax',
			'Standard delivery,0,0.00',
			'Pickup,"0",0'
		].join('\n')
		expect(csvToMarkdownTable(csv)).toBe(
			[
				'| Item | Fee | Tax |',
				'| --- | --- | --- |',
				'| Standard delivery | 0 | 0.00 |',
				'| Pickup | 0 | 0 |'
			].join('\n')
		)
	})

	test('escapes internal pipes, collapses embedded newlines and pads uneven rows', () => {
		const csv = [
			'Name,Notes,Price',
			'"A | B","Line 1\nLine 2",100',
			'Short row,Only two'
		].join('\n')
		expect(csvToMarkdownTable(csv)).toBe(
			[
				'| Name | Notes | Price |',
				'| --- | --- | --- |',
				'| A \\| B | Line 1 Line 2 | 100 |',
				'| Short row | Only two |  |'
			].join('\n')
		)
	})

	test('handles literal quotes mid-field without swallowing subsequent columns', () => {
		const csv = 'Item,Price,Currency\n12" Pizza,125,DKK\nSoda,35,DKK'
		expect(csvToMarkdownTable(csv)).toBe(
			[
				'| Item | Price | Currency |',
				'| --- | --- | --- |',
				'| 12" Pizza | 125 | DKK |',
				'| Soda | 35 | DKK |'
			].join('\n')
		)
	})

	test('returns trimmed text for single-row or single-column input', () => {
		expect(csvToMarkdownTable('OnlyHeader,Col2\n')).toBe('OnlyHeader,Col2')
		expect(csvToMarkdownTable('OneCol\nRow1\nRow2\n')).toBe(
			'OneCol\nRow1\nRow2'
		)
	})
})
