import { createHash } from 'node:crypto'

/**
 * Hex SHA-256 of a UTF-8 string or of raw bytes - the repo's one content-hash
 * function.
 *
 * Used as a change detector (has this text moved since we last derived from
 * it?), as an API-secret digest, and to fingerprint fetched binaries. The value
 * is a stored identity in several tables, so it must stay byte-for-byte what it
 * has always been.
 */
export function sha256Hex(data: string | Uint8Array): string {
	return typeof data === 'string'
		? createHash('sha256').update(data, 'utf8').digest('hex')
		: createHash('sha256').update(data).digest('hex')
}
