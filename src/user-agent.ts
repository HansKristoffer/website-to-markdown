/**
 * One stable browser UA for every origin request. Probe finding: at least one
 * customer site (kiropraktikicentrum.dk) answers 403 to `compatible; …`-style
 * bot UAs and 200 to a normal browser, and Browser Rendering must send the
 * same string so the two tiers are not treated as different visitors.
 */
export const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
