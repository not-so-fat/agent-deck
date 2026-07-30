import fs from 'node:fs';
import path from 'node:path';
import { normalizeTriggers } from '@agent-deck/shared';

export const STUB_MARKER_START_PREFIX = '<!-- agent-deck:stub:start';
export const STUB_MARKER_END = '<!-- agent-deck:stub:end -->';
export const STUB_DESCRIPTION_MAX_LENGTH = 1024;

export const CURSOR_STUBS_DIR = 'agent-deck-stubs';
export const CLAUDE_SKILL_PREFIX = 'agent-deck-';

export type PlaybookStubInput = {
  id: string;
  title: string;
  triggers: string[];
};

export type StubSyncCounts = {
  created: number;
  updated: number;
  removed: number;
};

export type StubSyncResult = {
  cursor: StubSyncCounts & { dir: string };
  claude: StubSyncCounts & { dirs: string[] };
};

export type StubBindSyncResult = {
  stubs: StubSyncResult;
  host_reload_required: boolean;
  manifestPath?: string;
};

export function slugFromPlaybook(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) {
    return slug;
  }
  return id.replace(/^pb_/, '');
}

/** Assign stable, collision-free Claude skill slugs for a deck's playbooks. */
export function resolvePlaybookSlugs(playbooks: PlaybookStubInput[]): Map<string, string> {
  const groups = new Map<string, PlaybookStubInput[]>();

  for (const playbook of playbooks) {
    const base = slugFromPlaybook(playbook.title, playbook.id);
    const group = groups.get(base) ?? [];
    group.push(playbook);
    groups.set(base, group);
  }

  const slugs = new Map<string, string>();
  for (const [base, items] of groups) {
    if (items.length === 1) {
      slugs.set(items[0].id, base);
      continue;
    }
    for (const playbook of items) {
      const suffix = playbook.id.replace(/^pb_/, '');
      slugs.set(playbook.id, `${base}-${suffix}`);
    }
  }

  return slugs;
}

export function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sanitizeStubTriggers(triggers: string[]): string[] {
  return normalizeTriggers(triggers, { maxCount: null });
}

export function buildStubDescription(playbook: PlaybookStubInput): string {
  const title = playbook.title.trim() || playbook.id;
  const triggers = sanitizeStubTriggers(playbook.triggers);
  const prefix = `${title} — use when the user asks about `;
  const suffix = `. Call get_playbook("${playbook.id}") before improvising.`;

  if (triggers.length === 0) {
    const body = `${prefix}${title}${suffix}`;
    return body.length <= STUB_DESCRIPTION_MAX_LENGTH
      ? body
      : `${body.slice(0, STUB_DESCRIPTION_MAX_LENGTH - 1)}…`;
  }

  let description = prefix;
  let usedTriggers = 0;
  for (const trigger of triggers) {
    const separator = usedTriggers === 0 ? '' : ', ';
    const next = `${description}${separator}${trigger}`;
    if (`${next}${suffix}`.length > STUB_DESCRIPTION_MAX_LENGTH) {
      if (usedTriggers === 0) {
        description = `${prefix}${trigger}`;
      }
      description = `${description}…`;
      break;
    }
    description = next;
    usedTriggers += 1;
  }

  const full = `${description}${suffix}`;
  return full.length <= STUB_DESCRIPTION_MAX_LENGTH
    ? full
    : `${full.slice(0, STUB_DESCRIPTION_MAX_LENGTH - 1)}…`;
}

export function buildCursorStubFile(playbook: PlaybookStubInput): string {
  const description = yamlSingleQuote(buildStubDescription(playbook));
  const markerStart = `${STUB_MARKER_START_PREFIX} ${playbook.id} -->`;
  return [
    '---',
    `description: ${description}`,
    'alwaysApply: false',
    '---',
    '',
    markerStart,
    `# ${playbook.title}`,
    '',
    'Playbook body lives on the deck — **never** copy procedure steps into this file.',
    '',
    `1. \`bind_workspace\` if needed, then \`get_playbook("${playbook.id}")\` before following steps.`,
    '2. On user correction: `propose_playbook_patch` — `add_item` for gotchas; `amend_item` only for exact list lines; `rewrite_body` for prose (not `update_playbook` unless they directed an edit).',
    STUB_MARKER_END,
    '',
  ].join('\n');
}

export function buildClaudeStubFile(playbook: PlaybookStubInput, slug?: string): string {
  const description = yamlSingleQuote(buildStubDescription(playbook));
  const markerStart = `${STUB_MARKER_START_PREFIX} ${playbook.id} -->`;
  const skillSlug = slug ?? slugFromPlaybook(playbook.title, playbook.id);
  return [
    '---',
    `name: ${CLAUDE_SKILL_PREFIX}${skillSlug}`,
    `description: ${description}`,
    '---',
    '',
    markerStart,
    `# ${playbook.title}`,
    '',
    'Playbook body lives on the deck — **never** copy procedure steps into this file.',
    '',
    `1. \`bind_workspace\` if needed, then \`get_playbook("${playbook.id}")\` before following steps.`,
    '2. On user correction: `propose_playbook_patch` — `add_item` for gotchas; `amend_item` only for exact list lines; `rewrite_body` for prose (not `update_playbook` unless they directed an edit).',
    STUB_MARKER_END,
    '',
  ].join('\n');
}

function readText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function isAgentDeckStub(content: string): boolean {
  return content.includes(STUB_MARKER_START_PREFIX) && content.includes(STUB_MARKER_END);
}

function stubPlaybookId(content: string): string | null {
  const match = content.match(/<!-- agent-deck:stub:start\s+(\S+)\s+-->/);
  return match?.[1] ?? null;
}

function cursorStubPath(stubsDir: string, playbookId: string): string {
  return path.join(stubsDir, `${playbookId}.mdc`);
}

function claudeSkillDir(skillsRoot: string, slug: string): string {
  return path.join(skillsRoot, `${CLAUDE_SKILL_PREFIX}${slug}`);
}

export type StubSyncOptions = {
  cursor?: boolean;
  claude?: boolean;
};

export function isStubSyncEnabled(): boolean {
  return process.env.AGENT_DECK_STUB_SYNC?.toLowerCase() !== 'off';
}

export function syncPlaybookStubs(
  workspaceRoot: string,
  playbooks: PlaybookStubInput[],
  options: StubSyncOptions = {},
): StubSyncResult {
  const writeCursor = options.cursor !== false;
  const writeClaude = options.claude !== false;
  const cursorDir = path.join(workspaceRoot, '.cursor', 'rules', CURSOR_STUBS_DIR);
  const claudeSkillsRoot = path.join(workspaceRoot, '.claude', 'skills');

  const result: StubSyncResult = {
    cursor: { created: 0, updated: 0, removed: 0, dir: cursorDir },
    claude: { created: 0, updated: 0, removed: 0, dirs: [] },
  };

  const expectedCursor = new Set(playbooks.map((playbook) => playbook.id));
  const slugByPlaybookId = resolvePlaybookSlugs(playbooks);

  if (fs.existsSync(cursorDir)) {
    for (const entry of fs.readdirSync(cursorDir)) {
      if (!writeCursor || !entry.endsWith('.mdc')) {
        continue;
      }
      const filePath = path.join(cursorDir, entry);
      const content = readText(filePath);
      if (!isAgentDeckStub(content)) {
        continue;
      }
      const playbookId = stubPlaybookId(content) ?? entry.replace(/\.mdc$/, '');
      if (!expectedCursor.has(playbookId)) {
        fs.unlinkSync(filePath);
        result.cursor.removed += 1;
      }
    }
  }

  if (fs.existsSync(claudeSkillsRoot)) {
    for (const entry of fs.readdirSync(claudeSkillsRoot, { withFileTypes: true })) {
      if (!writeClaude || !entry.isDirectory() || !entry.name.startsWith(CLAUDE_SKILL_PREFIX)) {
        continue;
      }
      const skillDir = path.join(claudeSkillsRoot, entry.name);
      const skillPath = path.join(skillDir, 'SKILL.md');
      const content = readText(skillPath);
      if (!isAgentDeckStub(content)) {
        continue;
      }
      const playbookId = stubPlaybookId(content);
      if (!playbookId || !expectedCursor.has(playbookId)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        result.claude.removed += 1;
      }
    }
  }

  for (const playbook of playbooks) {
    if (writeCursor) {
      const cursorPath = cursorStubPath(cursorDir, playbook.id);
      const nextCursor = buildCursorStubFile(playbook);
      const prevCursor = readText(cursorPath);
      if (!prevCursor.trim()) {
        writeText(cursorPath, nextCursor);
        result.cursor.created += 1;
      } else if (prevCursor !== nextCursor) {
        writeText(cursorPath, nextCursor);
        result.cursor.updated += 1;
      }
    }

    if (writeClaude) {
      const slug = slugByPlaybookId.get(playbook.id)!;
      const skillDir = claudeSkillDir(claudeSkillsRoot, slug);
      const skillPath = path.join(skillDir, 'SKILL.md');
      const nextClaude = buildClaudeStubFile(playbook, slug);
      const prevClaude = readText(skillPath);
      if (!prevClaude.trim()) {
        writeText(skillPath, nextClaude);
        result.claude.created += 1;
        result.claude.dirs.push(skillDir);
      } else if (prevClaude !== nextClaude) {
        writeText(skillPath, nextClaude);
        result.claude.updated += 1;
        result.claude.dirs.push(skillDir);
      } else {
        result.claude.dirs.push(skillDir);
      }
    }
  }

  return result;
}

export type UseManifest = {
  version: 1;
  deckId: string;
  deckName: string;
  mcpUrl: string;
  updatedAt: string;
};

export const USE_MANIFEST_PATH = '.agent-deck/use.json';

export function readUseManifest(workspaceRoot: string): UseManifest | null {
  const manifestPath = path.join(workspaceRoot, USE_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as UseManifest;
    if (parsed?.version === 1 && typeof parsed.deckId === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeUseManifest(workspaceRoot: string, manifest: UseManifest): string {
  const manifestPath = path.join(workspaceRoot, USE_MANIFEST_PATH);
  writeText(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

export function stubSyncChanged(result: StubSyncResult): boolean {
  const cursorChanged =
    result.cursor.created + result.cursor.updated + result.cursor.removed > 0;
  const claudeChanged =
    result.claude.created + result.claude.updated + result.claude.removed > 0;
  return cursorChanged || claudeChanged;
}

export function healUseManifest(
  workspaceRoot: string,
  deck: { id: string; name: string },
  mcpUrl?: string,
): string | undefined {
  const existing = readUseManifest(workspaceRoot);
  const next: UseManifest = {
    version: 1,
    deckId: deck.id,
    deckName: deck.name,
    mcpUrl: mcpUrl ?? existing?.mcpUrl ?? '',
    updatedAt: new Date().toISOString(),
  };
  if (
    existing &&
    existing.deckId === next.deckId &&
    existing.deckName === next.deckName &&
    existing.mcpUrl === next.mcpUrl
  ) {
    return undefined;
  }
  return writeUseManifest(workspaceRoot, next);
}
