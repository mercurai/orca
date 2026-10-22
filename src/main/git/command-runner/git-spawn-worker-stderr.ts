/** A broken progress observer must not interrupt capture or its transport acknowledgments. */
export function observeCaptureStderr(
  capture: { onStderr?: (chunk: string) => void } | undefined,
  data: Uint8Array,
  log: (message: string) => void
): void {
  if (!capture?.onStderr) {
    return
  }
  try {
    capture.onStderr(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'))
  } catch {
    capture.onStderr = undefined
    log('Git stderr observer failed; detached it')
  }
}
