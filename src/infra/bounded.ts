/**
 * A bounded wait. The timer is unref'd, so a pending bound never keeps the process alive, and it is always cleared once
 * `work` settles or the bound expires. On expiry the returned promise rejects with the operation's name and the bound, which
 * the caller records in its phase report; `work` itself is not cancelled and its eventual rejection is still handled by the
 * race, never reported as unhandled.
 */
export async function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  if (!(ms > 0)) throw new Error(`${what} did not finish within ${ms} ms`)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${what} did not finish within ${ms} ms`)) }, ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
