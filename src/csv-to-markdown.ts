function detectCsvDelimiter(text: string): ',' | ';' {
	let commas = 0
	let semicolons = 0
	let inQuotes = false
	let atFieldStart = true

	for (let index = 0; index < text.length; index++) {
		const ch = text[index]!
		if (inQuotes) {
			if (ch === '"') {
				if (text[index + 1] === '"') index += 1
				else inQuotes = false
			}
			continue
		}
		if (ch === '"' && atFieldStart) {
			inQuotes = true
			atFieldStart = false
		} else if (ch === ',') {
			commas += 1
			atFieldStart = true
		} else if (ch === ';') {
			semicolons += 1
			atFieldStart = true
		} else if (ch === '\r' || ch === '\n') {
			if (commas > 0 || semicolons > 0) break
			atFieldStart = true
		} else if (ch !== ' ' && ch !== '\t') {
			atFieldStart = false
		}
	}

	return semicolons > commas ? ';' : ','
}

function parseCsvRows(input: string): string[][] {
	const text = input.replace(/^\uFEFF/, '')
	const delimiter = detectCsvDelimiter(text)
	const rows: string[][] = []
	let row: string[] = []
	let cell = ''
	let inQuotes = false

	for (let index = 0; index < text.length; index++) {
		const ch = text[index]!
		if (inQuotes) {
			if (ch === '"') {
				if (text[index + 1] === '"') {
					cell += '"'
					index += 1
				} else {
					inQuotes = false
				}
			} else {
				cell += ch
			}
			continue
		}
		if (ch === '"' && cell.trim().length === 0) {
			cell = ''
			inQuotes = true
		} else if (ch === delimiter) {
			row.push(cell)
			cell = ''
		} else if (ch === '\r') {
			if (text[index + 1] === '\n') index += 1
			row.push(cell)
			rows.push(row)
			row = []
			cell = ''
		} else if (ch === '\n') {
			row.push(cell)
			rows.push(row)
			row = []
			cell = ''
		} else {
			cell += ch
		}
	}
	if (cell.length > 0 || row.length > 0) {
		row.push(cell)
		rows.push(row)
	}
	return rows
}

function escapeTableCell(value: string) {
	return value
		.replace(/\r?\n/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/\|/g, '\\|')
		.trim()
}

/**
 * Converts CSV text into a GFM Markdown pipe table so table-aware chunkers keep
 * headers on every chunk and every cell preserves its literal value (including
 * numeric zeros). Supports both comma- and semicolon-delimited CSVs, quoted
 * fields, embedded newlines and escaped quotes.
 */
export function csvToMarkdownTable(csv: string): string {
	const cleaned = csv.replaceAll('\u0000', '').normalize('NFC')
	const rows = parseCsvRows(cleaned).filter((row) =>
		row.some((cell) => cell.trim().length > 0)
	)
	if (rows.length < 2) return cleaned.replace(/^\uFEFF/, '').trim()
	const colCount = Math.max(...rows.map((row) => row.length))
	if (colCount < 2) return cleaned.replace(/^\uFEFF/, '').trim()

	const padRow = (row: string[]) =>
		Array.from({ length: colCount }, (_, index) =>
			escapeTableCell(row[index] ?? '')
		)

	const header = padRow(rows[0]!)
	const body = rows.slice(1).map(padRow)
	return [
		`| ${header.join(' | ')} |`,
		`| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
		...body.map((row) => `| ${row.join(' | ')} |`)
	].join('\n')
}
