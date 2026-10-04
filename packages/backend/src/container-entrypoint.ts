import { installStructuredConsole } from './lib/structured-console';

async function run(): Promise<void> {
  installStructuredConsole();
  const role = process.argv[2];
  if (role === 'backend') {
    await import('./index');
    return;
  }
  if (role === 'mcp') {
    await import('./mcp-index');
    return;
  }
  console.error('Usage: container-entrypoint <backend|mcp>');
  process.exitCode = 64;
}

void run();
