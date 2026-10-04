function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** Route application console output through newline-delimited JSON on stdout. */
export function installStructuredConsole(): void {
  const write = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
    const [first, ...rest] = args;
    const record: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      message: typeof first === 'string' ? first : 'application_log',
    };
    const values = (typeof first === 'string' ? rest : args).map(normalize);
    if (values.length > 0) record.values = values;
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  console.log = (...args: unknown[]) => write('info', args);
  console.info = (...args: unknown[]) => write('info', args);
  console.warn = (...args: unknown[]) => write('warn', args);
  console.error = (...args: unknown[]) => write('error', args);
}
