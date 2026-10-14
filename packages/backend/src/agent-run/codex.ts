/**
 * Codex adapter for `agent-deck run` (NOT-404).
 *
 * Drives `codex exec --json` (start) and `codex exec resume` (resume) as a
 * child process and maps the JSONL stream onto normalized events. Verified
 * against codex-cli 0.157.1 (`codex exec --help`, `codex exec resume --help`,
 * `codex login status`):
 *
 * - Start accepts `-s read-only|workspace-write`; resume accepts NO `-s`
 *   flag (neither does `fork`), so a resumed `edit` run fails closed in
 *   planStart instead of running with an unenforceable sandbox.
 * - Signed-in preflight is `codex login status` (exit 0 + `Logged in ...`),
 *   which makes no model call.
 * - `--skip-git-repo-check` exists on both start and resume and is passed
 *   only when --cwd is not inside a git work tree (recorded as
 *   `trustOverride: true` in meta.json).
 *
 * `--dangerously-bypass-approvals-and-sandbox` must never be used: there is
 * no flag, env var, or option that selects it, and tests assert no generated
 * argv ever contains it.
 */
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

import {
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunToolsProfile,
} from './adapter';

/** Tool-profile mapping: readonly is `-s read-only`, edit is `-s workspace-write`. */
export const CODEX_SANDBOX_FOR_PROFILE: Record<RunToolsProfile, 'read-only' | 'workspace-write'> = {
  readonly: 'read-only',
  edit: 'workspace-write',
};

export const CODEX_JSONL_VERSION_NOTE = 'codex-cli 0.157.1';

export function resolveCodexBin(): string {
  return process.env.CODEX_BIN?.trim() || 'codex';
}

export type CodexArgvArgs = {
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
  insideGitRepo: boolean;
};

/**
 * Resume ids are codex thread ids (UUIDs); a leading `-` is never legitimate
 * and would be parsed as a resume option (resume accepts
 * `--dangerously-bypass-approvals-and-sandbox`, `-c`, ...), so it fails
 * closed in planStart and throws here. Belt and suspenders with the `--`
 * placement below: this builder never emits a dash-leading id at all.
 */
export function assertSafeResumeId(resumeId: string): void {
  if (resumeId.startsWith('-')) {
    throw new Error(
      `Invalid --resume id ${JSON.stringify(resumeId)}: session ids never start with '-'. ` +
        'Pass the thread id printed as sessionId in a previous run log.',
    );
  }
}

/**
 * Pure argv builder (everything after the `codex` binary). Start:
 * `exec --json [--skip-git-repo-check] -s <mode> -- <prompt>`; resume:
 * `exec resume --json [--skip-git-repo-check] -- <thread> <prompt>`
 * (`codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` takes both positionals
 * after `--`; verified `--help` after `--` is treated as a positional, not
 * the help flag, on codex-cli 0.157.1).
 * Resume takes no `-s`: the thread keeps its original sandbox.
 * The `--` terminator keeps dash-leading prompts (markdown bullets, YAML
 * frontmatter, or a literal `--dangerously-...` string) from being parsed
 * as codex options.
 */
export function buildCodexArgv(args: CodexArgvArgs): string[] {
  const argv = ['exec'];
  const resuming = args.resumeId !== undefined;
  if (resuming) {
    assertSafeResumeId(args.resumeId as string);
    argv.push('resume');
  }
  argv.push('--json');
  if (!args.insideGitRepo) {
    argv.push('--skip-git-repo-check');
  }
  if (!resuming) {
    argv.push('-s', CODEX_SANDBOX_FOR_PROFILE[args.tools]);
  }
  argv.push('--');
  if (resuming) {
    argv.push(args.resumeId as string);
  }
  argv.push(args.prompt);
  return argv;
}

export function defaultIsGitRepo(cwd: string): boolean {
  try {
    const probed = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return probed.status === 0 && (probed.stdout ?? '').trim() === 'true';
  } catch {
    return false;
  }
}

export type CodexProbeResult = { code: number; stdout: string; stderr: string };
export type CodexProbe = (bin: string, argv: string[]) => CodexProbeResult;

export function defaultCodexProbe(bin: string, argv: string[]): CodexProbeResult {
  try {
    const probed = spawnSync(bin, argv, { encoding: 'utf8', timeout: 15000 });
    return { code: probed.status ?? 1, stdout: probed.stdout ?? '', stderr: probed.stderr ?? '' };
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

export type CodexChild = {
  /** Stdout split into lines (without line terminators). */
  stdout: AsyncIterable<string>;
  wait: () => Promise<{ code: number | null; stderrTail: string }>;
};

export type CodexSpawn = (bin: string, argv: string[], opts: { cwd: string }) => CodexChild;

export function defaultCodexSpawn(bin: string, argv: string[], opts: { cwd: string }): CodexChild {
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

export type CodexLineContext = { threadId: string | null };

function withSession<T extends object>(event: T, ctx: CodexLineContext): T & { sessionId?: string } {
  return ctx.threadId ? { ...event, sessionId: ctx.threadId } : event;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Map one `codex exec --json` stdout line onto normalized events:
 * `thread.started.thread_id` becomes the session id (no log line);
 * `agent_message` items become `text`; command/tool items become `tool`;
 * `turn.completed` becomes `result` (subtype `success`); provider `error`
 * events become `notice` (non-fatal). Unknown kinds are ignored so a newer
 * CLI cannot break the log. Never throws: unparseable lines become `notice`.
 */
export function codexEventsFromLine(line: string, ctx: CodexLineContext): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    return [
      withSession(
        { kind: 'notice', message: `unparseable codex output: ${trimmed.slice(0, 300)}` },
        ctx,
      ),
    ];
  }
  const record = asRecord(event);
  if (!record) {
    return [];
  }

  switch (record.type) {
    case 'thread.started': {
      const threadId = nonEmptyString(record.thread_id);
      if (threadId) {
        ctx.threadId = threadId;
      }
      return [];
    }
    case 'item.completed': {
      const item = asRecord(record.item);
      if (!item) {
        return [];
      }
      if (item.type === 'agent_message') {
        const text = nonEmptyString(item.text) ?? nonEmptyString(item.content);
        return text ? [withSession({ kind: 'text', text }, ctx)] : [];
      }
      if (item.type === 'reasoning') {
        return [];
      }
      const name =
        nonEmptyString(item.name) ??
        (nonEmptyString(item.command) ? `command:${item.command as string}`.slice(0, 200) : null) ??
        nonEmptyString(item.type) ??
        'item';
      return [withSession({ kind: 'tool', name }, ctx)];
    }
    case 'turn.completed': {
      const usage = record.usage === undefined ? null : { usage: record.usage };
      return [withSession({ kind: 'result', subtype: 'success', result: usage }, ctx)];
    }
    case 'turn.failed': {
      const detail = record.error ?? record.usage ?? null;
      return [withSession({ kind: 'result', subtype: 'failed', result: detail }, ctx)];
    }
    case 'error': {
      const message =
        nonEmptyString(record.message) ?? `codex error: ${trimmed.slice(0, 300)}`;
      return [withSession({ kind: 'notice', message: message.slice(0, 500) }, ctx)];
    }
    default:
      // turn.started and any future kinds carry nothing the log needs.
      return [];
  }
}

export function codexTrustOverride(cwd: string, isGitRepo: (cwd: string) => boolean): boolean {
  try {
    return !isGitRepo(cwd);
  } catch {
    return true;
  }
}

export type CodexAdapterDeps = {
  bin?: string;
  probe?: CodexProbe;
  spawn?: CodexSpawn;
  isGitRepo?: (cwd: string) => boolean;
};

export function createCodexAdapter(deps: CodexAdapterDeps = {}): ClientAdapter {
  const bin = deps.bin ?? resolveCodexBin();
  const probe = deps.probe ?? defaultCodexProbe;
  const spawnFn = deps.spawn ?? defaultCodexSpawn;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;

  return {
    id: 'codex',

    async preflight() {
      const version = probe(bin, ['--version']);
      if (version.code !== 0) {
        return {
          ok: false,
          remedy:
            `codex CLI not found (tried "${bin}"): install codex-cli 0.157+ and ensure 'codex' is on PATH (or set CODEX_BIN=/path/to/codex), then retry.`,
        };
      }
      const login = probe(bin, ['login', 'status']);
      // `login status` reports on stderr ("Logged in using ChatGPT" on 0.157.1),
      // so both streams count; the anchored match rejects "Not logged in".
      const loginText = `${login.stdout}\n${login.stderr}`;
      if (login.code !== 0 || !/^\s*logged in/im.test(loginText)) {
        return {
          ok: false,
          remedy: 'codex is not signed in: run `codex login`, then retry.',
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
            'Pass the thread id printed as sessionId in a previous run log.',
        };
      }
      if (args.resumeId !== undefined && args.tools === 'edit') {
        return {
          ok: false,
          remedy:
            `Cannot resume codex thread ${args.resumeId} with --tools edit: 'codex exec resume' accepts no sandbox flag, ` +
            'so the edit sandbox cannot be enforced on resume. Start a new run without --resume, or resume with --tools readonly.',
        };
      }
      return { ok: true, trustOverride: codexTrustOverride(args.cwd, isGitRepo) };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const insideGitRepo = !codexTrustOverride(args.cwd, isGitRepo);
      const argv = buildCodexArgv({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
        insideGitRepo,
      });
      if (args.resumeId !== undefined) {
        yield {
          kind: 'notice',
          message:
            `Resuming codex thread ${args.resumeId}: the thread keeps its original sandbox; ` +
            `--tools ${args.tools} is recorded but cannot be re-applied on resume.`,
          sessionId: args.resumeId,
        };
      }
      const wrapSpawnError = (error: unknown): Error =>
        new Error(
          `codex run failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
        );
      let child: CodexChild;
      try {
        child = spawnFn(bin, argv, { cwd: args.cwd });
      } catch (error) {
        throw wrapSpawnError(error);
      }
      const ctx: CodexLineContext = { threadId: args.resumeId ?? null };
      try {
        for await (const line of child.stdout) {
          for (const event of codexEventsFromLine(line, ctx)) {
            yield event;
          }
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
          `codex exited with code ${code}${stderrTail ? `: ${stderrTail.slice(0, 300)}` : ''}`,
        );
      }
    },
  };
}
