import { createHash } from 'node:crypto'

/**
 * Hex SHA-256 of a UTF-8 string or of raw bytes. `htmlHash` and snapshot file
 * names are built on it, and callers store them, so it must stay byte-for-byte
 * what it has always been.
 */
export function sha256Hex(data: string | Uint8Array): string {
	return typeof data === 'string'
		? createHash('sha256').update(data, 'utf8').digest('hex')
		: createHash('sha256').update(data).digest('hex')
}
