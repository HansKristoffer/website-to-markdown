# Changelog

## [2.0.0](https://github.com/HansKristoffer/website-to-markdown/compare/v1.1.1...v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* localhost is refused unless `allowLocalhost: true` is passed (1.x allowed it whenever NODE_ENV was not production), and `isHostAllowed(hostname, logger)` is `isHostAllowed(hostname, { logger, allowLocalhost })`. `FetchedPage.alternates`, `alternateLanguages`, `captureIssue` and `htmlHash` are required, and `captureIssue` is the `CaptureIssue` union. A Browser Rendering 429 is reported as `browser_rendering_rate_limited` instead of `workers_ai_rate_limited`. The conversion version is bumped, so every page is converted once more after the upgrade.

### Features

* guard every redirect, bound every body, and never throw from fetchPageAsMarkdown ([4f4edda](https://github.com/HansKristoffer/website-to-markdown/commit/4f4edda6a0c26e490917980b5b65695d825fb854))


### Bug Fixes

* **deps:** upgrade hanzio to 3.4.0 and read robots.txt with hanzio/sitemap ([b3086d0](https://github.com/HansKristoffer/website-to-markdown/commit/b3086d0d80509b92296b739532b00cdfbe5df3f1))
* **deps:** upgrade hanzio to 3.4.0 and read robots.txt with hanzio/sitemap ([f5098b9](https://github.com/HansKristoffer/website-to-markdown/commit/f5098b9b54202643f3345642d635716e728b77f7))

## [1.1.1](https://github.com/HansKristoffer/website-to-markdown/compare/v1.1.0...v1.1.1) (2026-10-21)


### Bug Fixes

* **cli:** ignore unknown flags and extra positionals again ([#7](https://github.com/HansKristoffer/website-to-markdown/issues/7)) ([3e4a0de](https://github.com/HansKristoffer/website-to-markdown/commit/3e4a0de6db594b390e410ef3307d75f668bf9b54))

## [1.1.0](https://github.com/HansKristoffer/website-to-markdown/compare/v1.0.1...v1.1.0) (2026-10-21)


### Features

* remove hellu's website-to-markdown re-wraps ([#5](https://github.com/HansKristoffer/website-to-markdown/issues/5)) ([e2bf520](https://github.com/HansKristoffer/website-to-markdown/commit/e2bf52020ae030f6393cdeceb56d8a0f69cb9389))

## [1.0.1](https://github.com/HansKristoffer/website-to-markdown/compare/v1.0.0...v1.0.1) (2026-10-21)


### Miscellaneous Chores

* release 1.0.1 ([14c6730](https://github.com/HansKristoffer/website-to-markdown/commit/14c6730ed6d0e2be376aa508ff0acd0806c42125))

## 1.0.0 (2026-10-20)


### Features

* port url-to-markdown and sitemap discovery from hellu ([f1c33e1](https://github.com/HansKristoffer/website-to-markdown/commit/f1c33e1352dd8e4e02b60a96c0220086b1521c45))
* port url-to-markdown and sitemap discovery from hellu ([540a20f](https://github.com/HansKristoffer/website-to-markdown/commit/540a20f3bc6b7b2f74317169bf27536700d75afe))
