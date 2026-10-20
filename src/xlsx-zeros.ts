import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const MAX_EXPANDED_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10_000
const WORKSHEET_PATH = /^xl\/worksheets\/[^/]+\.xml$/
const LITERAL_ZERO_CELL =
	/<((?:[A-Za-z_][\w.-]*:)?c)\b([^>]*)>\s*<((?:[A-Za-z_][\w.-]*:)?v)>\s*([+-]?0(?:\.0+)?)\s*<\/\3>\s*<\/\1>/g

/**
 * Workers AI treats a numeric zero cell as empty. Send literal zeros as text
 * in its conversion copy, retaining the original bytes in storage. Formula,
 * boolean and shared-string cells keep their types and contents.
 */
export function preserveXlsxZeros(bytes: ArrayBuffer) {
	let expandedBytes = 0
	let entryCount = 0
	const entries = unzipSync(new Uint8Array(bytes), {
		filter: (entry) => {
			expandedBytes += entry.originalSize
			entryCount += 1
			if (
				expandedBytes > MAX_EXPANDED_BYTES ||
				entryCount > MAX_ARCHIVE_ENTRIES
			) {
				throw new Error('Spreadsheet archive exceeds conversion limits')
			}
			return true
		}
	})
	let changed = false

	for (const [path, content] of Object.entries(entries)) {
		if (!WORKSHEET_PATH.test(path)) continue
		const xml = strFromU8(content)
		const next = xml.replace(
			LITERAL_ZERO_CELL,
			(
				match: string,
				tag: string,
				attributes: string,
				_valueTag: string,
				zero: string
			) => {
				const type = /(?:^|\s)t\s*=\s*(["'])(.*?)\1/.exec(attributes)?.[2]
				if (type && type !== 'n') return match

				const prefix = tag.slice(0, -1)
				const rest = attributes.replace(/\s+t\s*=\s*(["'])n\1/, '')
				return `<${tag}${rest} t="inlineStr"><${prefix}is><${prefix}t>${zero}</${prefix}t></${prefix}is></${tag}>`
			}
		)
		if (next === xml) continue
		entries[path] = strToU8(next)
		changed = true
	}

	return changed ? Uint8Array.from(zipSync(entries)).buffer : bytes
}
