import {
	type ApiError,
	HttpResponseError,
	RequestTimeoutError
} from 'hanzio/api-wrapper'

/**
 * Whether `onApiError` hears about a Workers AI client error. A 429 never: it
 * is retried and trips the shared cooldown, and reporting every one floods the
 * error tracker. A timeout only with `reportTimeouts`, since the page falls
 * through to the next tier anyway.
 */
export function isReportableApiError(error: ApiError, reportTimeouts = true) {
	if (error instanceof HttpResponseError && error.status === 429) return false
	return reportTimeouts || !(error instanceof RequestTimeoutError)
}
