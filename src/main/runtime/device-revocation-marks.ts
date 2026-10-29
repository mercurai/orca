// Why: revocation fails closed; a device being revoked is refused before any of its writes land.
export class DeviceRevocationMarks {
  private readonly counts = new Map<string, number>()

  /** Marks the device until the returned release runs; counted, so nested revokes compose. */
  begin(deviceId: string): () => void {
    this.counts.set(deviceId, (this.counts.get(deviceId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.counts.get(deviceId) ?? 1) - 1
      if (remaining > 0) {
        this.counts.set(deviceId, remaining)
      } else {
        this.counts.delete(deviceId)
      }
    }
  }

  has(deviceId: string): boolean {
    return this.counts.has(deviceId)
  }
}
