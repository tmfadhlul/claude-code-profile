import { AsyncLocalStorage } from 'node:async_hooks'

const sink = new AsyncLocalStorage<(msg: string) => void>()

/** Run `fn` with `report` receiving every `step()` made inside it, however deep the call. */
export function withProgress<T>(report: (msg: string) => void, fn: () => T): T {
  return sink.run(report, fn)
}

/** Report a step of a long-running operation to whoever is listening (the web UI); no-op otherwise. */
export function step(msg: string): void {
  sink.getStore()?.(msg)
}
