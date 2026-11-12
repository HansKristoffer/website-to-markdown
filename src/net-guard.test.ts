import { afterAll, describe, expect, mock, test } from 'bun:test'
import { createWebsiteToMarkdown } from './fetch-page.js'
import {
	followRedirects,
	guardedFetch,
	HostNotAllowedError,
	isBlockedAddress,
	isHostAllowed,
	isLocalhostHostname
} from './net-guard.js'

describe('isBlockedAddress', () => {
	test('allows public IPv4', () => {
		for (const address of ['93.184.216.34', '8.8.8.8', '185.45.16.10']) {
			expect(isBlockedAddress(address)).toBe(false)
		}
	})

	test('blocks private, loopback, link-local and CGNAT IPv4', () => {
		for (const address of [
			'0.0.0.0',
			'10.0.0.1',
			'127.0.0.1',
			'100.64.0.1',
			'100.127.255.255',
			'169.254.169.254',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'198.18.0.1',
			'224.0.0.1',
			'255.255.255.255'
		]) {
			expect(isBlockedAddress(address)).toBe(true)
		}
	})

	test('allows public IPv4 next to the private ranges', () => {
		for (const address of ['172.32.0.1', '172.15.0.1', '100.128.0.1']) {
			expect(isBlockedAddress(address)).toBe(false)
		}
	})

	test('allows public IPv6', () => {
		expect(isBlockedAddress('2a00:1450:4001:82f::200e')).toBe(false)
		expect(isBlockedAddress('[2606:4700:4700::1111]')).toBe(false)
	})

	test('blocks loopback, unique-local, link-local and multicast IPv6', () => {
		for (const address of [
			'::1',
			'::',
			'fc00::1',
			'fd12:3456::1',
			'fe80::1%en0',
			'ff02::1',
			'2001:db8::1'
		]) {
			expect(isBlockedAddress(address)).toBe(true)
		}
	})

	test('judges IPv4-mapped IPv6 by the embedded address', () => {
		expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true)
		expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true)
		expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false)
	})

	test('fails closed on anything it cannot parse', () => {
		for (const address of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', 'gg::1']) {
			expect(isBlockedAddress(address)).toBe(true)
		}
	})
})

describe('isLocalhostHostname', () => {
	test('recognises the loopback names', () => {
		expect(isLocalhostHostname('localhost')).toBe(true)
		expect(isLocalhostHostname('127.0.0.1')).toBe(true)
		expect(isLocalhostHostname('[::1]')).toBe(true)
		expect(isLocalhostHostname('khtf.dk')).toBe(false)
	})
})

describe('createWebsiteToMarkdown isHostAllowed', () => {
	test('is the guard the converter runs, bound to its logger', async () => {
		const warn = mock(() => {})
		const { isHostAllowed } = createWebsiteToMarkdown({
			cloudflare: { apiToken: 'token', accountId: 'account' },
			logger: { info() {}, warn }
		})

		expect(await isHostAllowed('127.0.0.2')).toBe(false)
		expect(warn).toHaveBeenCalledWith('net-guard.blocked_address', {
			hostname: '127.0.0.2',
			addresses: '127.0.0.2'
		})
	})

	test('is the isHostAllowed option when one is given', () => {
		const guard = async () => true
		const converter = createWebsiteToMarkdown({
			cloudflare: { apiToken: 'token', accountId: 'account' },
			isHostAllowed: guard
		})
		expect(converter.isHostAllowed).toBe(guard)
	})
})

describe('isHostAllowed', () => {
	test('judges an IP literal as written, brackets and all, without DNS', async () => {
		expect(await isHostAllowed('[fd00::1]')).toBe(false)
		expect(await isHostAllowed('[::ffff:169.254.169.254]')).toBe(false)
		expect(await isHostAllowed('[::ffff:a9fe:a9fe]')).toBe(false)
		expect(await isHostAllowed('10.0.0.1')).toBe(false)
		expect(await isHostAllowed('93.184.216.34')).toBe(true)
		expect(await isHostAllowed('[2606:4700:4700::1111]')).toBe(true)
	})

	test('refuses localhost unless allowLocalhost is set', async () => {
		expect(await isHostAllowed('localhost')).toBe(false)
		expect(await isHostAllowed('[::1]')).toBe(false)
		expect(await isHostAllowed('localhost', { allowLocalhost: true })).toBe(
			true
		)
	})
})

describe('followRedirects', () => {
	const metadata = Bun.serve({
		port: 0,
		fetch: () => new Response('secret')
	})
	const metadataHit = mock(() => {})
	const site = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === '/to-metadata') {
				metadataHit()
				return Response.redirect(
					`http://127.0.0.1:${metadata.port}/metadata`,
					302
				)
			}
			if (url.pathname === '/hop') return Response.redirect('/page', 301)
			return new Response(`page ${request.method}`)
		}
	})
	afterAll(() => {
		metadata.stop(true)
		site.stop(true)
	})
	const onlyLocalhostName = async (hostname: string) => hostname === 'localhost'

	test('checks every redirect target, not just the first URL', async () => {
		const pending = guardedFetch(
			`http://localhost:${site.port}/to-metadata`,
			undefined,
			{ isHostAllowed: onlyLocalhostName }
		)
		await expect(pending).rejects.toBeInstanceOf(HostNotAllowedError)
		expect(metadataHit).toHaveBeenCalledTimes(1)
	})

	test('follows an allowed redirect and reports where it ended', async () => {
		const { response, url } = await followRedirects(
			`http://localhost:${site.port}/hop`,
			undefined,
			{ isHostAllowed: onlyLocalhostName }
		)
		expect(await response.text()).toBe('page GET')
		expect(url.pathname).toBe('/page')
	})

	test('drops credentials on a cross-origin hop and turns a 303 into a GET', async () => {
		const seen: { url: string; method: string; auth: string | null }[] = []
		const fetch = mock(async (input: string | URL, init?: RequestInit) => {
			const url = String(input)
			seen.push({
				url,
				method: init?.method ?? 'GET',
				auth: new Headers(init?.headers).get('authorization')
			})
			return url.startsWith('https://a.example')
				? new Response(null, {
						status: 303,
						headers: { location: 'https://b.example/done' }
					})
				: new Response('ok')
		})
		await guardedFetch(
			'https://a.example/form',
			{ method: 'POST', body: 'x', headers: { authorization: 'Bearer t' } },
			{ isHostAllowed: async () => true, fetch }
		)
		expect(seen).toEqual([
			{ url: 'https://a.example/form', method: 'POST', auth: 'Bearer t' },
			{ url: 'https://b.example/done', method: 'GET', auth: null }
		])
	})

	test('gives up after maxRedirects', async () => {
		const fetch = mock(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://loop.example/' }
				})
		)
		await expect(
			guardedFetch('https://loop.example/', undefined, {
				isHostAllowed: async () => true,
				fetch,
				maxRedirects: 2
			})
		).rejects.toThrow('Too many redirects')
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	test('refuses a scheme other than http(s) on a redirect', async () => {
		const fetch = mock(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: 'file:///etc/passwd' }
				})
		)
		await expect(
			guardedFetch('https://a.example/', undefined, {
				isHostAllowed: async () => true,
				fetch
			})
		).rejects.toBeInstanceOf(HostNotAllowedError)
	})
})
