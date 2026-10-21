/**
 * Values a shared schema can import without the runtime: no Node built-ins,
 * no peer libraries.
 */

/** A crawl snapshot name, `<snapshot>/<host>`; it becomes a path, so it may not climb out of the root. */
export const CRAWL_SNAPSHOT_NAME_PATTERN =
	/^[a-z0-9._-]{1,80}\/[a-z0-9._-]{1,120}$/

export type CrawlSnapshotInput = {
	mode: 'record' | 'replay'
	/** `<snapshot>/<host>`: the bench's snapshot label, then the site. */
	name: string
}
