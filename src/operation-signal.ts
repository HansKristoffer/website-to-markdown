import { AsyncLocalStorage } from 'node:async_hooks'

type Operation = {
	signal: AbortSignal
	/** Ends the whole operation with a reason its stages will rethrow. */
	abort?: ((reason: Error) => void) | undefined
}

const operation = new AsyncLocalStorage<Operation>()

/** Carries a job's cancellation through nested model calls without global mutable state. */
export function withOperationSignal<T>(
	signal: AbortSignal,
	run: () => Promise<T>,
	abort?: Operation['abort']
) {
	return operation.run({ signal, abort }, run)
}

export function currentOperationSignal() {
	return operation.getStore()?.signal
}

/**
 * A failure no retry can heal (the provider refused to bill the request):
 * abort the operation so its next stage throws `reason` instead of treating
 * the call as one more transient miss. A no-op outside an abortable operation.
 */
export function failCurrentOperation(reason: Error) {
	operation.getStore()?.abort?.(reason)
}
