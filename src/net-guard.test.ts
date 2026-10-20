import { describe, expect, test } from 'bun:test'
import { isBlockedAddress, isLocalhostHostname } from './net-guard.js'

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
