import { inspect } from 'util';

const isDebug = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
let installed = false;

function formatArgs(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === 'string') {
      return arg;
    }

    return inspect(arg, {
      depth: 6,
      colors: false,
      breakLength: Infinity,
    });
  }).join(' ');
}

function writeStderr(level: string, args: unknown[], always: boolean = false): void {
  if (!always && !isDebug) {
    return;
  }

  process.stderr.write(`[${level}] ${formatArgs(args)}\n`);
}

export function installStdioConsoleGuard(): void {
  if (installed) {
    return;
  }

  installed = true;

  console.log = (...args: unknown[]) => writeStderr('LOG', args);
  console.info = (...args: unknown[]) => writeStderr('INFO', args);
  console.debug = (...args: unknown[]) => writeStderr('DEBUG', args);
  console.warn = (...args: unknown[]) => writeStderr('WARN', args, true);
  console.error = (...args: unknown[]) => writeStderr('ERROR', args, true);
}
