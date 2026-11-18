type TranscriptLine = {
  type?: unknown;
  role?: unknown;
  isSidechain?: unknown;
  toolUseResult?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

const CURSOR_USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
const CURSOR_TIMESTAMP_RE = /<timestamp>\s*[\s\S]*?\s*<\/timestamp>\s*/gi;

/** Structural Claude / Cursor host chrome — durable, locale-independent. */
const HOST_INJECTION_TAGS = [
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<system-reminder>',
  '<mcp_meta_tools>',
] as const;

/**
 * Supplemental English / host-phrasing prefixes (Cursor injections, session-continue).
 * Structural tags + Cursor `<user_query>` gate are the durable filters; this list is a safety net.
 */
const HOST_INJECTION_PREFIXES = [
  'Briefly inform the user about the task result',
  'The beginning of the above subagent result is already visible to the user',
  'If the available MCP tools do not fully support what the user asked you to do',
  'This session is being continued from a previous conversation',
  'Base directory for this skill:',
  '===== BEGIN SESSION TRANSCRIPT',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Raw message text before Cursor envelope unwrap. */
export function extractRawUserText(line: unknown): string | null {
  if (!isRecord(line) || !isRecord(line.message)) {
    return null;
  }

  const { content } = line.message;
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content) || content.some((block) => !isRecord(block) || block.type !== 'text' || typeof block.text !== 'string')) {
    return null;
  }

  return content.map((block) => (block as { text: string }).text).join('\n');
}

/**
 * Strip Cursor `<timestamp>` / unwrap `<user_query>…</user_query>`.
 * Claude string content is unchanged (no those tags).
 */
export function unwrapCursorUserEnvelope(raw: string): string {
  const text = raw.replace(CURSOR_TIMESTAMP_RE, '').trim();
  const match = CURSOR_USER_QUERY_RE.exec(text);
  if (match) {
    return match[1]!.trim();
  }
  return text.trim();
}

/** Host-injected user-role text for both Claude and Cursor (not a human task intent). */
export function isHostInjectedUserText(raw: string): boolean {
  const lowerTags = raw; // tags are ASCII
  if (HOST_INJECTION_TAGS.some((tag) => lowerTags.includes(tag))) {
    return true;
  }
  const unwrapped = unwrapCursorUserEnvelope(raw);
  return HOST_INJECTION_PREFIXES.some(
    (prefix) => unwrapped.startsWith(prefix) || raw.includes(prefix),
  );
}

/** @deprecated Prefer isHostInjectedUserText — kept for call-site clarity in Cursor-focused tests. */
export function isCursorHostInjection(raw: string): boolean {
  return isHostInjectedUserText(raw);
}

export function extractUserText(line: unknown): string | null {
  const raw = extractRawUserText(line);
  if (raw === null) {
    return null;
  }
  const text = unwrapCursorUserEnvelope(raw);
  return text.length > 0 ? text : null;
}

export function isRealUserIntent(line: unknown): boolean {
  if (!isRecord(line)) {
    return false;
  }

  const transcriptLine = line as TranscriptLine;
  if (transcriptLine.isSidechain === true) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(transcriptLine, 'toolUseResult')) {
    return false;
  }

  const raw = extractRawUserText(transcriptLine);
  if (raw === null || raw.trim().length === 0) {
    return false;
  }

  // Shared host-injection gate (Claude slash/hook chrome + Cursor injected role:user).
  if (isHostInjectedUserText(raw)) {
    return false;
  }

  // Cursor role:user without <user_query> is almost always host chrome.
  // Real Cursor turns (dated or legacy) wrap the body in <user_query>.
  const messageRole = isRecord(transcriptLine.message) ? transcriptLine.message.role : undefined;
  const looksLikeCursorUser =
    transcriptLine.role === 'user' || (messageRole === 'user' && transcriptLine.type !== 'user');
  if (looksLikeCursorUser && !CURSOR_USER_QUERY_RE.test(raw) && !raw.includes('<timestamp>')) {
    return false;
  }

  const text = unwrapCursorUserEnvelope(raw);
  if (text.length === 0) {
    return false;
  }

  const isUser =
    transcriptLine.type === 'user' ||
    transcriptLine.role === 'user' ||
    messageRole === 'user';
  if (!isUser) {
    return false;
  }

  // Cursor control lines (turn_ended, etc.) must not count even if they carry a message blob.
  if (
    typeof transcriptLine.type === 'string' &&
    transcriptLine.type !== 'user' &&
    transcriptLine.type !== 'assistant' &&
    transcriptLine.role !== 'user'
  ) {
    return false;
  }

  return true;
}
