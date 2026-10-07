// Spawns the REAL `pnpm loadtest <command>` entry point (loadtest/cli.ts,
// via its `tsx` script -- package.json's `"loadtest": "tsx loadtest/cli.ts"`)
// as a child process, streaming its stdout/stderr to this process's own
// console (prefixed) so a run's live status lines are visible in the
// Playwright terminal reporter / CI log, and resolving with the captured
// output once the process exits.
//
// Deliberately a subprocess, not a direct import of cli.ts's internal
// functions: loadtest/cli.ts itself has zero dedicated tests anywhere else
// in the repo (its argv parsing, flag clamping and top-level error
// redaction are only exercised by callers), so this is the one place that
// is actually driving the tool the way an operator's shell would.
import { spawn } from 'node:child_process';

export interface RunCliOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  // Prefix for streamed output lines, e.g. "[fund]", "[run]".
  label: string;
}

export interface RunCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const runCli = (args: string[], options: RunCliOptions): Promise<RunCliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'loadtest/cli.ts', ...args], {
      cwd: options.cwd,
      env: options.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    const pipe = (chunk: Buffer, sink: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8');
      if (sink === 'stdout') stdout += text;
      else stderr += text;
      for (const line of text.split('\n')) {
        if (line.length > 0) process.stdout.write(`${options.label} ${line}\n`);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => pipe(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => pipe(chunk, 'stderr'));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

/**
 * Runs `pnpm loadtest <command>` and throws (with the tail of stdout+stderr
 * in the error message, for a readable Playwright failure) unless it exits
 * 0.
 */
export const runCliOrThrow = async (
  args: string[],
  options: RunCliOptions
): Promise<RunCliResult> => {
  const result = await runCli(args, options);
  if (result.code !== 0) {
    const tail = (text: string): string => text.split('\n').slice(-40).join('\n');
    throw new Error(
      `${options.label} "pnpm loadtest ${args.join(' ')}" exited ${result.code}${result.timedOut ? ' (timed out)' : ''}\n` +
        `--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`
    );
  }
  return result;
};
