/** Scalar attributes only, so any OpenTelemetry-backed logger can take them. */
export type LogAttributes = Record<string, string | number | boolean>

/** The two levels this library logs at; an app logger usually fits as is. */
export type Logger = {
	info: (message: string, attributes?: LogAttributes) => void
	warn: (message: string, attributes?: LogAttributes) => void
}

export const silentLogger: Logger = { info() {}, warn() {} }

export function errorLogAttributes(error: unknown): LogAttributes {
	return error instanceof Error
		? { error_message: error.message, error_type: error.name }
		: { error_message: String(error) }
}
