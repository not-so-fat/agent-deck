/** Remove terminal ANSI SGR/OSC sequences that break JSON when pasted into config files. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-_]/g, '');
}

/** Strip ANSI and other C0 controls except tab/newline/carriage return. */
export function sanitizeJsonText(text: string): string {
  const withoutAnsi = stripAnsi(text);
  let cleaned = '';
  for (const char of withoutAnsi) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) {
      cleaned += char;
    }
  }
  return cleaned;
}
