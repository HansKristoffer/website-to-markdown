import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './cli.js'

const server = Bun.serve({
	port: 0,
	fetch: () =>
		new Response('# About\n\nHello from the fixture.', {
			headers: { 'content-type': 'text/markdown; charset=utf-8' }
		})
})
const directory = await mkdtemp(join(tmpdir(), 'website-to-markdown-cli-'))
afterAll(async () => {
	server.stop(true)
	await rm(directory, { recursive: true, force: true })
})

const env = { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' }

async function run(argv: string[], runEnv: Record<string, string> = env) {
	let stdout = ''
	let stderr = ''
	const code = await main(argv, {
		stdout: { write: (text) => (stdout += text) },
		stderr: { write: (text) => (stderr += text) },
		env: runEnv
	})
	return { code, stdout, stderr }
}

const help = `Usage: website-to-markdown <url> [options]

Fetch a public URL as markdown. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.

Arguments:
  <url>  e.g. https://example.com/about

Options:
  --[no-]render        Use the Browser Rendering tier; --no-render keeps to HTML tiers. (default: true)
  --env-file <string>  Read CLOUDFLARE_* from a dotenv file; the environment wins.
  -h, --help           Show help
`

test('help', async () => {
	expect(await run(['https://example.com', '--help'])).toEqual({
		code: 0,
		stdout: help,
		stderr: ''
	})
	// No URL prints the help and exits 1, as 1.0 did.
	expect(await run([])).toEqual({ code: 1, stdout: help, stderr: '' })
	expect(await run(['--help'])).toEqual({ code: 1, stdout: help, stderr: '' })
})

test('fetches a page: markdown to stdout, metadata to stderr', async () => {
	const url = `http://localhost:${server.port}/about`
	const { code, stdout, stderr } = await run([url, '--no-render'])
	expect(code).toBe(0)
	expect(stdout).toBe('# About\n\nHello from the fixture.\n')
	const [fetching, ...metadata] = stderr.split('\n')
	expect(fetching).toBe(`Fetching ${url}…`)
	const { durationMs, ...page } = JSON.parse(metadata.join('\n'))
	expect(durationMs).toBeNumber()
	expect(page).toEqual({
		outcome: 'ok',
		status: 200,
		source: 'content-negotiation',
		url,
		finalUrl: url,
		contentType: 'text/markdown; charset=utf-8',
		etag: null,
		lastModified: null,
		title: 'About',
		lang: null,
		canonical: null,
		metaDescription: null,
		jsonLdBlocks: 0,
		links: 0,
		images: 0,
		markdownChars: 32
	})
})

test('missing Cloudflare credentials exit 1', async () => {
	expect(await run(['https://example.com'], {})).toEqual({
		code: 1,
		stdout: '',
		stderr: 'Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.\n'
	})
})

test('--env-file supplies the Cloudflare credentials', async () => {
	const envFile = join(directory, '.env')
	await writeFile(
		envFile,
		'CLOUDFLARE_API_TOKEN=token\nCLOUDFLARE_ACCOUNT_ID="account"\n'
	)
	const url = `http://localhost:${server.port}/about`
	const { code, stdout } = await run(
		[url, '--no-render', '--env-file', envFile],
		{}
	)
	expect(code).toBe(0)
	expect(stdout).toBe('# About\n\nHello from the fixture.\n')

	// The environment wins over the file; a file that lacks one still fails.
	await writeFile(envFile, 'CLOUDFLARE_API_TOKEN=token\n')
	expect((await run([url, '--no-render', '--env-file', envFile])).code).toBe(0)
	expect(
		(await run([url, '--no-render', '--env-file', envFile], {})).stderr
	).toBe('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.\n')
})

test('an unreadable --env-file exits 1', async () => {
	const envFile = join(directory, 'missing.env')
	expect(await run(['https://example.com', '--env-file', envFile], {})).toEqual(
		{ code: 1, stdout: '', stderr: `Cannot read --env-file ${envFile}.\n` }
	)
})

test('unknown flags and extra positionals are ignored', async () => {
	const url = `http://localhost:${server.port}/about`
	const { code, stdout } = await run([url, 'extra', '--bogus', '--no-render'])
	expect(code).toBe(0)
	expect(stdout).toBe('# About\n\nHello from the fixture.\n')
})
