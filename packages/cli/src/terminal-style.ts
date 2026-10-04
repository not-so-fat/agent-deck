const ANSI = {
  bold: '1',
  dim: '2',
  red: '31',
  yellow: '33',
  cyan: '36',
} as const;

export function terminalColorsEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (Boolean(process.env.NO_COLOR) || process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(stream.isTTY);
}

function wrap(value: string, codes: string[], enabled: boolean): string {
  if (!enabled) {
    return value;
  }
  return `\u001b[${codes.join(';')}m${value}\u001b[0m`;
}

export const terminalStyle = {
  bold: (value: string, enabled: boolean) => wrap(value, [ANSI.bold], enabled),
  dim: (value: string, enabled: boolean) => wrap(value, [ANSI.dim], enabled),
  error: (value: string, enabled: boolean) => wrap(value, [ANSI.bold, ANSI.red], enabled),
  warning: (value: string, enabled: boolean) => wrap(value, [ANSI.bold, ANSI.yellow], enabled),
  command: (value: string, enabled: boolean) => wrap(value, [ANSI.bold, ANSI.cyan], enabled),
};
