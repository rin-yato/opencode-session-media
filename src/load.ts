import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"

/**
 * A promise's result as plain signals, re-run whenever `source` changes. Use it instead of
 * `createResource`: OpenCode wraps the session screen in `<Suspense>`, and reading a pending
 * resource there swaps the whole screen for its fallback and back, which resets every scroll
 * position in it. Nothing here ever suspends.
 *
 * `source` returns `undefined` or `false` to wait. A new source clears the old value, and a
 * result that arrives after its source changed is dropped.
 */
export function createLoad<S, T>(
  source: () => S | undefined | false,
  fetch: (source: S) => Promise<T>,
): { value: Accessor<T | undefined>; failed: Accessor<boolean> } {
  const [value, setValue] = createSignal<T>()
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    const input = source()
    setValue(undefined)
    setFailed(false)
    if (input === undefined || input === false) return
    let live = true
    onCleanup(() => (live = false))
    untrack(() => fetch(input)).then(
      (result) => live && setValue(() => result),
      () => live && setFailed(true),
    )
  })
  return { value, failed }
}
