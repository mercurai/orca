import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import type { ChildProcessHandle } from './process-spec'

export type CaptureProcessOptions = Pick<ExecFileOptions, 'cwd' | 'env' | 'encoding' | 'maxBuffer'>

/** Node capture semantics for callers that own deadlines, stdin and tree termination. */
export function captureProcess(
  program: string,
  args: readonly string[],
  options: CaptureProcessOptions,
  onResult: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void
): ChildProcessHandle {
  return execFile(program, [...args], { ...options, windowsHide: true }, onResult)
}
