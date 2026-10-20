/** A server that mislabels HTML as `text/plain` still needs the HTML tier. */
export function looksLikeHtml(body: string) {
	return /^\s*<(!doctype\s+html|html)[\s>]/i.test(body)
}

/**
 * Deliberately "empty", not "short": a real 300-character opening-hours page
 * must not be promoted to Browser Rendering, which is the slow, rate-limited
 * tier and the only one that ever timed out in the probe.
 */
export function isBlankMarkdown(markdown: string) {
	return markdown.trim().length === 0
}

/** Below this, prose next to an empty mount node is leftover chrome, not content. */
const EMPTY_MOUNT_MAX_PROSE_LENGTH = 60
/** Below this, a "loading"/"enable JavaScript" phrase dominates the page. */
const PLACEHOLDER_MAX_PROSE_LENGTH = 500

/** Require a JS bootstrap signal AND missing meaningful prose before rendering.
 * Short opening-hours pages remain on the fast path. */
export function isApplicationShell(html: string, markdown: string) {
	const bootstrap =
		/<script\b[^>]*\bsrc\s*=|id=["'](?:root|app|__next|__nuxt)["']/i.test(html)
	if (!bootstrap) return false
	const prose = markdown
		.replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/^[#*\s-]+/gm, '')
		.trim()
	// ponytail: Placeholder phrases cover English; replace with structural rendered-content signals.
	const placeholder =
		/(?:enable|requires?|turn on)\s+javascript|loading(?:\.{3}|…)?|please wait/i.test(
			prose
		)
	const emptyMount =
		/<(?:div|main)\b[^>]*id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\//i.test(
			html
		)
	return (
		!prose ||
		(prose.length < EMPTY_MOUNT_MAX_PROSE_LENGTH &&
			emptyMount &&
			!/\d/.test(prose)) ||
		(prose.length < PLACEHOLDER_MAX_PROSE_LENGTH && placeholder)
	)
}
