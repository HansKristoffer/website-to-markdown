import { lookup } from 'node:dns/promises'
import { createCache, isOneOf } from 'hanzio'
import { errorLogAttributes, type Logger, silentLogger } from './logger.js'

/** One crawl hits the same host hundreds of times; DNS is not cached by Node. */
const RESOLUTION_TTL_MS = 60_000
const RESOLUTION_CACHE_MAX = 512

function parseIpv4(address: string): number[] | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	const octets: number[] = []
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const value = Number(part)
		if (value > 255) return null
		octets.push(value)
	}
	return octets
}

function isBlockedIpv4(octets: number[]) {
	const [a = 0, b = 0] = octets
	return (
		a === 0 || // "this network"
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) || // IETF protocol assignments
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast + reserved + broadcast
	)
}

function ipv4TailGroups(part: string): number[] | null {
	const octets = parseIpv4(part)
	if (!octets) return null
	return [
		((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
		((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
	]
}

function parseIpv6Side(side: string): number[] | null {
	if (!side) return []
	const parts = side.split(':')
	const groups: number[] = []
	for (const [index, part] of parts.entries()) {
		if (part.includes('.')) {
			const tail = index === parts.length - 1 ? ipv4TailGroups(part) : null
			if (!tail) return null
			groups.push(...tail)
			continue
		}
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
		groups.push(Number.parseInt(part, 16))
	}
	return groups
}

function parseIpv6(address: string): number[] | null {
	const head = address.split('%')[0] ?? ''
	if (!head.includes(':')) return null
	const halves = head.split('::')
	if (halves.length > 2) return null

	const left = parseIpv6Side(halves[0] ?? '')
	const right = halves.length === 2 ? parseIpv6Side(halves[1] ?? '') : []
	if (!left || !right) return null
	if (halves.length === 1) return left.length === 8 ? left : null

	const filled = 8 - left.length - right.length
	if (filled < 1) return null
	return [...left, ...new Array<number>(filled).fill(0), ...right]
}

/**
 * Refuse anything that is not a routable public address. Fails closed: an
 * address we cannot parse is treated as blocked, because the only reason to
 * fetch it is a customer website and those resolve to public addresses.
 */
export function isBlockedAddress(address: string): boolean {
	const trimmed = address.trim().replace(/^\[|\]$/g, '')
	const ipv4 = parseIpv4(trimmed)
	if (ipv4) return isBlockedIpv4(ipv4)

	const groups = parseIpv6(trimmed)
	if (!groups) return true

	const [first = 0, second = 0] = groups
	// ::ffff:a.b.c.d and ::a.b.c.d carry an IPv4 address; judge that instead.
	const isMapped =
		groups.slice(0, 5).every((group) => group === 0) &&
		(groups[5] === 0xffff || groups[5] === 0)
	if (isMapped) {
		const embedded = [
			(groups[6] ?? 0) >> 8,
			(groups[6] ?? 0) & 0xff,
			(groups[7] ?? 0) >> 8,
			(groups[7] ?? 0) & 0xff
		]
		if (embedded.every((octet) => octet === 0)) return true // :: and ::1
		if (embedded[0] === 0 && embedded[1] === 0 && embedded[2] === 0) return true
		return isBlockedIpv4(embedded)
	}

	return (
		(first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(first & 0xff00) === 0xff00 || // ff00::/8 multicast
		(first === 0x2001 && second === 0x0db8) // documentation range
	)
}

export function isLocalhostHostname(hostname: string) {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return isOneOf(['localhost', '127.0.0.1', '::1'], host)
}

const resolutionCache = createCache({
	defaultTtlMs: RESOLUTION_TTL_MS,
	maxEntries: RESOLUTION_CACHE_MAX
})

/**
 * SSRF guard: a customer can put any hostname in the website field, and an
 * internal address behind it would turn the importer into a proxy for our own
 * network. Localhost stays reachable outside production for the dev server.
 */
export async function isHostAllowed(
	hostname: string,
	logger: Logger = silentLogger
) {
	if (isLocalhostHostname(hostname)) {
		return process.env.NODE_ENV !== 'production'
	}

	const cached = resolutionCache.get<boolean>(hostname)
	if (cached !== undefined) return cached

	let allowed = false
	try {
		const addresses = await lookup(hostname, { all: true })
		allowed =
			addresses.length > 0 &&
			addresses.every((entry) => !isBlockedAddress(entry.address))
		if (!allowed) {
			logger.warn('net-guard.blocked_address', {
				hostname,
				addresses: addresses.map((entry) => entry.address).join(',')
			})
		}
	} catch (error) {
		// DNS failure is a transient network condition, not a policy decision:
		// let the fetch run and report the real error.
		logger.warn('net-guard.lookup_failed', {
			hostname,
			...errorLogAttributes(error)
		})
		return true
	}

	resolutionCache.set(hostname, allowed)
	return allowed
}
