import { describe, expect, test } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { preserveXlsxZeros } from './xlsx-zeros.js'

function archive(cells: string) {
	return Uint8Array.from(
		zipSync({
			'xl/worksheets/sheet1.xml': strToU8(
				`<worksheet><sheetData><row r="5">${cells}</row></sheetData></worksheet>`
			),
			'xl/workbook.xml': strToU8('<workbook/>')
		})
	).buffer
}

function sheet(bytes: ArrayBuffer) {
	const content = unzipSync(new Uint8Array(bytes))['xl/worksheets/sheet1.xml']
	if (!content) throw new Error('Fixture worksheet is missing')
	return strFromU8(content)
}

describe('spreadsheet zero preservation for conversion', () => {
	test('retains a free-delivery value while leaving the stored original untouched', () => {
		const original = archive(
			'<c r="A5" t="inlineStr"><is><t>Delivery</t></is></c><c r="B5"><v>0</v></c><c r="C5" t="inlineStr"><is><t>DKK</t></is></c>'
		)
		const copy = new Uint8Array(original).slice()

		const converted = preserveXlsxZeros(original)

		expect(sheet(converted)).toContain(
			'<c r="B5" t="inlineStr"><is><t>0</t></is></c>'
		)
		expect(sheet(converted)).toContain('<t>Delivery</t>')
		expect(sheet(converted)).toContain('<t>DKK</t>')
		expect(new Uint8Array(original)).toEqual(copy)
		expect(unzipSync(new Uint8Array(converted))['xl/workbook.xml']).toEqual(
			strToU8('<workbook/>')
		)
	})

	test('preserves explicitly numeric and namespaced zero cells', () => {
		const source = archive('<s:c r="A5" t="n" s="1"><s:v>0.00</s:v></s:c>')

		const converted = preserveXlsxZeros(source)

		expect(sheet(converted)).toContain(
			'<s:c r="A5" s="1" t="inlineStr"><s:is><s:t>0.00</s:t></s:is></s:c>'
		)
	})

	test('does not alter formulas, booleans, strings, nonzero values or blank cells', () => {
		const source = archive(
			'<c r="A5"><f>A1-A2</f><v>0</v></c><c r="B5" t="b"><v>0</v></c><c r="C5" t="s"><v>0</v></c><c r="D5"><v>300</v></c><c r="E5"/>'
		)

		expect(preserveXlsxZeros(source)).toBe(source)
	})

	test('rejects an oversized expanded archive before allocating its contents', () => {
		const source = new Uint8Array(archive('<c r="B5"><v>0</v></c>'))
		const view = new DataView(source.buffer)
		for (let offset = 0; offset < source.length - 46; offset++) {
			if (view.getUint32(offset, true) !== 0x02014b50) continue
			view.setUint32(offset + 24, MAX_EXPANDED_FIXTURE_BYTES, true)
			break
		}

		expect(() => preserveXlsxZeros(source.buffer)).toThrow(
			'Spreadsheet archive exceeds conversion limits'
		)
	})
})

const MAX_EXPANDED_FIXTURE_BYTES = 100 * 1024 * 1024 + 1
