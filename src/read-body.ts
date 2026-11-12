/**
 * At most `maxBytes` of a response body, streamed, so a chunked body is bounded
 * as well as a declared `Content-Length`. `truncated` says the body went on;
 * the rest is cancelled, never downloaded.
 */
export async function readBody(response: Response, maxBytes: number) {
	const reader = response.body?.getReader()
	if (!reader) return { bytes: new Uint8Array(0), truncated: false }
	const chunks: Uint8Array[] = []
	let size = 0
	let truncated = false
	while (true) {
		const next = await reader.read()
		if (next.done) break
		const room = maxBytes - size
		if (next.value.byteLength > room) {
			chunks.push(next.value.subarray(0, room))
			size = maxBytes
			truncated = true
			await reader.cancel()
			break
		}
		chunks.push(next.value)
		size += next.value.byteLength
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { bytes, truncated }
}

/** UTF-8, as `Response.text()` decodes whatever the charset header says. */
export function decodeText(bytes: Uint8Array) {
	return new TextDecoder().decode(bytes)
}
