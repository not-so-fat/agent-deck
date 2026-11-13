/**
 * NOT-597: human-approved deck assignment for unassigned (headerless) folders.
 *
 * A headerless MCP session carries no `x-agent-deck-workspace`, so the
 * server does not know the folder. The agent supplies the folder as a
 * `workspace` path argument; the approval panel displays it in full and
 * the path is only trusted after the user approves that panel.
 *
 * Why a `workspace` argument instead of MCP `roots/list`:
 * - `roots/list` is optional — hosts may not advertise `roots`, may return
 *   an empty list, or may return multiple roots with no way to pick the
 *   intended folder without asking the agent anyway.
 * - The observed Codex session (global headerless fallback after a 2.4.0
 *   upgrade) offers only `get_session_context`; relying on `roots/list`
 *   would leave exactly that session unable to request assignment.
 * - An explicit argument is testable over plain HTTP (the acceptance
 *   tests use a headerless client and an existing folder) and keeps the
 *   trust boundary obvious: the daemon validates the shape, the human
 *   verifies the displayed path, and only then does the daemon write.
 */
import fs from 'node:fs';
import path from 'node:path';

export type AssignmentWorkspaceValidation =
  | { ok: true; workspaceRoot: string }
  | { ok: false; error: string };

/**
 * Validate a caller-supplied folder for a deck-assignment request.
 * Refuses a missing path, a non-absolute path, any path containing `..`,
 * and a path that is not an existing directory. Returns the resolved
 * absolute path on success; callers must write only inside it.
 */
export function validateAssignmentWorkspace(workspace: unknown): AssignmentWorkspaceValidation {
  if (typeof workspace !== 'string' || workspace.trim().length === 0) {
    return { ok: false, error: 'workspace is required — pass the absolute folder path' };
  }
  const trimmed = workspace.trim();
  if (trimmed.includes('..')) {
    return { ok: false, error: 'workspace must not contain `..`' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, error: 'workspace must be an absolute path' };
  }
  const resolved = path.resolve(trimmed);
  // `..` was rejected above, but resolve-then-check keeps symlink-free
  // callers honest: the resolved path must equal the trimmed input's
  // resolution and must not escape via `.` segments.
  if (resolved.includes('..')) {
    return { ok: false, error: 'workspace must not contain `..`' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: 'workspace does not exist or is not accessible' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: 'workspace is not a directory' };
  }
  return { ok: true, workspaceRoot: resolved };
}

/**
 * True when `candidate` stays inside `workspaceRoot` (or equals it).
 * Used to guarantee assignment writes never escape the approved folder.
 */
export function isPathInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
