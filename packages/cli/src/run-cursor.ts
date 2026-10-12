/**
 * Cursor adapter for `agent-deck run` (NOT-406).
 *
 * Drives `cursor-agent -p --trust --output-format json` (start and resume, the
 * latter adding `--resume <chatId>`) as a child process and maps the single
 * result object onto normalized events. Verified against cursor-agent
 * 2026.10.01 (`cursor-agent --help`, `cursor-agent status --format json`):
 *
 * - Output format is single-shot `json`, not `stream-json`: the stream-json
 *   event shape is uncaptured (no incremental events were observed), while
 *   the owner's smoke test verified `json` returns a result object with
 *   `session_id`. Consequence: all log lines land when the process exits, so
 *   status polling shows no intermediate lines for Cursor.
 * - The answer text is yielded as one `text` event (so the shared session
 *   receipt check sees it) followed by `result`; the full result object is
 *   the `result` payload.
 * - Tool mapping: `readonly` passes no write-enabling flag; `edit` passes
 *   `--force`. `--yolo` (an alias for `--force`) is never passed and no
 *   option can select it; `--approve-mcps` is never passed (separate owner
 *   decision required).
 * - Deck receipt is mandatory on start (not resume): a success whose output
 *   lacks a `◆ ... ·` display_summary line fails closed as `error`, because
 *   Cursor's global MCP entry is last-workspace-wins and a missing receipt
 *   would otherwise look like a correctly bound run. Resume is exempt (the
 *   harness prints the receipt on the first turn only).
 * - `--force` means "allow commands unless explicitly denied" (auto-approval),
 *   and `-p` help says print mode "has access to all tools, including write
 *   and shell", so whether readonly truly cannot write is settled by the
 *   operator edit-vs-readonly test, not by the flags.
 * - `--trust` is passed on every launch (the caller named --cwd explicitly)
 *   and recorded as `trustOverride: true` in meta.json — the existing meta
 *   field for "launch bypassed a client workspace-trust guard". Without it
 *   the CLI prints "Workspace Trust Required" with an empty success, so that
 *   string (and any empty result at exit 0) fails closed as `error`.
 * - Signed-in preflight is `cursor-agent status --format json` (exit 0 even
 *   when signed out, so the output is parsed, not just the exit code), which
 *   makes no model call.
 * - The prompt is passed after a `--` terminator (verified: `cursor-agent -p
 *   --trust --output-format json -- --help` treats `--help` as the prompt
 *   instead of printing help), so dash-leading prompts cannot be parsed as
 *   options. Resume ids starting with `-` fail closed in planStart.
 */
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

import {
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunToolsProfile,
} from './run-adapter';

export const CURSOR_JSON_VERSION_NOTE = 'cursor-agent 2026.10.01';

/** Single-shot result object; stream-json incremental shape is unverified. */
export const CURSOR_OUTPUT_FORMAT = 'json';

export function resolveCursorBin(): string {
  return process.env.CURSOR_BIN?.trim() || 'cursor-agent';
}

export type CursorArgvArgs = {
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
};

/**
 * Resume ids are cursor chat ids (32-hex); a leading `-` is never legitimate
 * and would be parsed as a cursor-agent option, so it fails closed in
 * planStart and throws here. Belt and suspenders with the `--` placement
 * below: this builder never emits a dash-leading id at all.
 */
export function assertSafeCursorResumeId(resumeId: string): void {
  if (resumeId.startsWith('-')) {
    throw new Error(
      `Invalid --resume id ${JSON.stringify(resumeId)}: session ids never start with '-'. ` +
        'Pass the chat id printed as sessionId in a previous run log.',
    );
  }
}

/**
 * Pure argv builder (everything after the `cursor-agent` binary):
 * `-p --trust --output-format json [--force] [--resume <id>] -- <prompt>`.
 * `--force` only for the edit profile; `--yolo` and `--approve-mcps` are
 * never emitted. The `--` terminator keeps dash-leading prompts from being
 * parsed as cursor-agent options.
 */
export function buildCursorArgv(args: CursorArgvArgs): string[] {
  const argv = ['-p', '--trust', '--output-format', CURSOR_OUTPUT_FORMAT];
  if (args.tools === 'edit') {
    argv.push('--force');
  }
  if (args.resumeId !== undefined) {
    assertSafeCursorResumeId(args.resumeId);
    argv.push('--resume', args.resumeId);
  }
  argv.push('--', args.prompt);
  return argv;
}

export type CursorProbeResult = { code: number; stdout: string; stderr: string };
export type CursorProbe = (bin: string, argv: string[]) => CursorProbeResult;

export function defaultCursorProbe(bin: string, argv: string[]): CursorProbeResult {
  try {
    const probed = spawnSync(bin, argv, { encoding: 'utf8', timeout: 15000 });
    return { code: probed.status ?? 1, stdout: probed.stdout ?? '', stderr: probed.stderr ?? '' };
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

export type CursorChild = {
  /** Stdout split into lines (without line terminators). */
  stdout: AsyncIterable<string>;
  wait: () => Promise<{ code: number | null; stderrTail: string }>;
};

export type CursorSpawn = (bin: string, argv: string[], opts: { cwd: string }) => CursorChild;

export function defaultCursorSpawn(bin: string, argv: string[], opts: { cwd: string }): CursorChild {
  const child = spawn(bin, argv, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError: Error | null = null;
  child.on('error', (error) => {
    spawnError = error;
    child.stdout?.destroy();
  });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  async function* lines(): AsyncGenerator<string> {
    const rl = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of rl) {
        yield line;
      }
    } catch {
      // The stdout stream is destroyed when the spawn itself fails; the
      // spawn error below is the actionable failure.
    }
    if (spawnError) {
      throw spawnError;
    }
  }

  const wait = (): Promise<{ code: number | null; stderrTail: string }> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          code,
          stderrTail: Buffer.concat(stderrChunks).toString('utf8').slice(-2000),
        });
      };
      child.on('close', done);
      child.on('error', () => done(127));
    });

  return { stdout: lines(), wait };
}

/**
 * `cursor-agent status --format json` exits 0 even when signed out
 * (`{"status":"unauthenticated","isAuthenticated":false,...}`), so the
 * output decides. The `isAuthenticated` boolean wins; the `status` string
 * and a text fallback cover older shapes. Unknown output fails closed.
 */
export function isCursorStatusAuthenticated(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.isAuthenticated === 'boolean') {
          return record.isAuthenticated;
        }
        if (typeof record.status === 'string') {
          const status = record.status.trim().toLowerCase();
          if (status === 'authenticated') {
            return true;
          }
          if (status === 'unauthenticated') {
            return false;
          }
        }
      }
    } catch {
      // Fall through to the text heuristics below.
    }
  }
  if (/not logged in|unauthenticated/i.test(trimmed)) {
    return false;
  }
  return /logged in/i.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && !!entry);
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry) {
      names.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const name =
      nonEmptyString(record.name) ??
      nonEmptyString(record.tool) ??
      (nonEmptyString(record.command) ? `command:${record.command as string}`.slice(0, 200) : null);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Map the single-shot `--output-format json` stdout onto normalized events:
 * the result object's `session_id` becomes `sessionId`; the answer text
 * becomes one `text` event; tool arrays become `tool` events; warning arrays
 * become `notice` events; the full object becomes the `result` payload
 * (subtype `success`, or `failed` when the object carries `error`,
 * `is_error: true`, or a non-`success` subtype).
 *
 * Throws (so the shared run code marks the run `error`) on "Workspace Trust
 * Required", on empty output at exit 0, on non-JSON output, on a result
 * object with no answer text, tool call, or error content (a bare session
 * id, including the resume-id fallback, is not content), and — on start
 * only, not resume — on a success whose output lacks a `◆ ... ·` deck
 * receipt line. Never returns an empty event list: success always ends with
 * a `result` event.
 */
export function cursorEventsFromOutput(
  stdout: string,
  opts: { resumeId?: string } = {},
): NormalizedEvent[] {
  if (stdout.includes('Workspace Trust Required')) {
    throw new Error(
      'cursor-agent reported "Workspace Trust Required": open the folder in Cursor and accept the workspace trust prompt, then retry.',
    );
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      'cursor-agent returned an empty result (exit 0): retry the run; if it persists, check `cursor-agent status` and re-run the prompt by hand to see the raw error.',
    );
  }

  let resultObject: Record<string, unknown> | null = null;
  let parsedWhole = false;
  try {
    resultObject = asRecord(JSON.parse(trimmed) as unknown);
    parsedWhole = resultObject !== null;
  } catch {
    parsedWhole = false;
  }
  const notices: NormalizedEvent[] = [];
  if (!parsedWhole) {
    // Tolerate warning lines around the result object; anything that is not
    // JSON becomes a notice so a newer CLI cannot break the log.
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim();
      if (!candidate) {
        continue;
      }
      try {
        const parsed = asRecord(JSON.parse(candidate) as unknown);
        if (parsed) {
          resultObject = parsed;
        }
      } catch {
        notices.push({
          kind: 'notice',
          message: `unparseable cursor-agent output: ${candidate.slice(0, 300)}`,
        });
      }
    }
  }
  if (!resultObject) {
    throw new Error(
      `cursor-agent returned unexpected (non-JSON) output: ${trimmed.slice(0, 300)} Re-run the prompt by hand with --output-format json to see the raw error.`,
    );
  }

  // Session aliases are chat-id shaped only: a bare `id` may be a request
  // or message id rather than the chat id, which would resume the wrong
  // session.
  const sessionId =
    firstString(resultObject, ['session_id', 'sessionId', 'chat_id', 'chatId']) ??
    opts.resumeId ??
    null;
  const withSession = sessionId ? { sessionId } : {};

  const errorValue = resultObject.error;
  const errorText = nonEmptyString(errorValue);
  const isErrorFlag = resultObject.is_error === true;
  const subtypeRaw = nonEmptyString(resultObject.subtype);
  const nonSuccessSubtype =
    subtypeRaw && subtypeRaw !== 'success' ? subtypeRaw : null;
  if (errorText || asRecord(errorValue) || isErrorFlag || nonSuccessSubtype) {
    return [
      ...notices.map((notice) =>
        sessionId ? { ...notice, sessionId } : notice,
      ),
      {
        kind: 'result',
        subtype: nonSuccessSubtype ?? 'failed',
        result: errorValue ?? resultObject,
        ...withSession,
      },
    ];
  }

  const events: NormalizedEvent[] = [...notices];
  const warnings = [
    ...stringArray(resultObject.warnings),
    ...stringArray(resultObject.notices),
    ...stringArray(resultObject.messages).filter((message) => /warn/i.test(message)),
  ];
  for (const warning of warnings) {
    events.push({ kind: 'notice', message: warning.slice(0, 500), ...withSession });
  }

  const answerText = firstString(resultObject, [
    'result',
    'text',
    'message',
    'response',
    'output',
    'answer',
  ]);
  // Array content blocks (claude-style text/tool_use) when the result nests them.
  const blocks = Array.isArray(resultObject.content) ? resultObject.content : [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    if ((record.type === 'text' || record.type === undefined) && typeof record.text === 'string' && record.text) {
      events.push({ kind: 'text', text: record.text, ...withSession });
    } else if (
      (record.type === 'tool_use' || record.type === 'function_call') &&
      typeof record.name === 'string' &&
      record.name
    ) {
      events.push({ kind: 'tool', name: record.name, ...withSession });
    }
  }
  if (answerText) {
    events.push({ kind: 'text', text: answerText, ...withSession });
  }
  const tools = [
    ...toolNames(resultObject.tool_calls),
    ...toolNames(resultObject.tools_used),
    ...toolNames(resultObject.tools),
  ];
  for (const name of tools) {
    events.push({ kind: 'tool', name: name.slice(0, 200), ...withSession });
  }

  // A bare session id (including the resume-id fallback) is not content:
  // `{"session_id":"x","result":""}` and `{}` on --resume are empty results.
  const hasContent =
    answerText !== null ||
    tools.length > 0 ||
    events.some((event) => event.kind === 'text' || event.kind === 'tool');
  if (!hasContent) {
    throw new Error(
      'cursor-agent returned an empty result (exit 0): the result object has no answer text or tool calls — retry the run; if it persists, re-run the prompt by hand to see the raw error.',
    );
  }

  // Mandatory deck receipt on start: without a `◆ ... ·` display_summary
  // line the run cannot prove it bound to the requested deck (Cursor's
  // global MCP entry is last-workspace-wins). Resume is exempt — the
  // harness prints the receipt on the first turn only, so a resumed turn
  // legitimately carries no new receipt. A present-but-wrong receipt is
  // caught by the shared mismatch check in run.ts.
  if (opts.resumeId === undefined && !/◆\s*[^·\r\n]+?\s*·/.test(stdout)) {
    throw new Error(
      "cursor-agent run produced no deck receipt (missing ◆ display_summary line): the session may be bound to another folder's deck. Ask the agent to call get_session_context and print display_summary verbatim, then retry.",
    );
  }

  events.push({ kind: 'result', subtype: 'success', result: resultObject, ...withSession });
  return sessionId
    ? events.map((event) => ('sessionId' in event && event.sessionId ? event : { ...event, sessionId }))
    : events;
}

export type CursorAdapterDeps = {
  bin?: string;
  probe?: CursorProbe;
  spawn?: CursorSpawn;
};

export function createCursorAdapter(deps: CursorAdapterDeps = {}): ClientAdapter {
  const bin = deps.bin ?? resolveCursorBin();
  const probe = deps.probe ?? defaultCursorProbe;
  const spawnFn = deps.spawn ?? defaultCursorSpawn;

  return {
    id: 'cursor',

    async preflight() {
      const version = probe(bin, ['--version']);
      if (version.code !== 0) {
        return {
          ok: false,
          remedy:
            `cursor-agent CLI not found (tried "${bin}"): install cursor-agent 2026.10+ and ensure 'cursor-agent' is on PATH (or set CURSOR_BIN=/path/to/cursor-agent), then retry.`,
        };
      }
      const status = probe(bin, ['status', '--format', 'json']);
      if (status.code !== 0 || !isCursorStatusAuthenticated(status.stdout)) {
        return {
          ok: false,
          remedy: 'cursor-agent is not signed in: run `cursor-agent login`, then retry.',
        };
      }
      return { ok: true };
    },

    planStart(args: AdapterStartArgs) {
      if (args.resumeId !== undefined && args.resumeId.startsWith('-')) {
        return {
          ok: false,
          remedy:
            `Invalid --resume id ${JSON.stringify(args.resumeId)}: session ids never start with '-'. ` +
            'Pass the chat id printed as sessionId in a previous run log.',
        };
      }
      // --trust is passed on every launch, so every cursor run records the
      // workspace-trust grant.
      return { ok: true, trustOverride: true };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const argv = buildCursorArgv({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
      });
      const wrapSpawnError = (error: unknown): Error =>
        new Error(
          `cursor-agent run failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
        );
      let child: CursorChild;
      try {
        child = spawnFn(bin, argv, { cwd: args.cwd });
      } catch (error) {
        throw wrapSpawnError(error);
      }
      const lines: string[] = [];
      try {
        for await (const line of child.stdout) {
          lines.push(line);
        }
      } catch (error) {
        throw wrapSpawnError(error);
      }
      let settled: { code: number | null; stderrTail: string };
      try {
        settled = await child.wait();
      } catch (error) {
        throw wrapSpawnError(error);
      }
      const { code, stderrTail } = settled;
      if (code !== 0) {
        throw new Error(
          `cursor-agent exited with code ${code}${stderrTail ? `: ${stderrTail.slice(0, 300)}` : ''}`,
        );
      }
      // Single-shot json: the whole stdout is one result object, so every
      // event lands here, when the process exits.
      yield* cursorEventsFromOutput(lines.join('\n'), {
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
      });
    },
  };
}
