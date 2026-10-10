import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveMuseGlobalConfigDir } from './mcp-config';

export const MUSE_SKILL_IDS = [
  'agent-deck-session',
  'agent-deck-playbooks',
  'agent-deck-setup',
] as const;

export type MuseSkillId = (typeof MUSE_SKILL_IDS)[number];

/** Footer stamp distinguishing Agent Deck-managed skills from user collisions. */
export const MUSE_MANAGED_SKILL_MARKER = '<!-- agent-deck:managed-skill -->';

export function resolveMuseSkillsDir(home: string = os.homedir()): string {
  return path.join(resolveMuseGlobalConfigDir(home), 'muse', 'skills');
}

export function resolveMuseSkillFile(
  skillId: MuseSkillId,
  home: string = os.homedir(),
): string {
  return path.join(resolveMuseSkillsDir(home), skillId, 'SKILL.md');
}

/**
 * Packaged skill resource. Built CLI reads dist/muse-skills (copied from the
 * canonical root skills/ by scripts/copy-muse-skills.mjs); dev/test falls back
 * to the repo root skills/ tree.
 */
export function resolveMuseSkillResourcePath(skillId: MuseSkillId): string | null {
  const candidates = [
    path.join(__dirname, 'muse-skills', skillId, 'SKILL.md'),
    path.join(__dirname, '..', '..', '..', 'skills', skillId, 'SKILL.md'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function readMuseSkillTemplate(skillId: MuseSkillId): string {
  const resource = resolveMuseSkillResourcePath(skillId);
  if (!resource) {
    throw new Error(
      `Muse skill resource missing for ${skillId} (expected dist/muse-skills/${skillId}/SKILL.md from skills/${skillId}/SKILL.md; rebuild the CLI)`,
    );
  }
  return fs.readFileSync(resource, 'utf8');
}

export function buildMuseManagedSkillContent(template: string): string {
  const body = template.endsWith('\n') ? template : `${template}\n`;
  const separator = body.endsWith('\n\n') ? '' : '\n';
  return `${body}${separator}${MUSE_MANAGED_SKILL_MARKER}\n`;
}

export function isMuseManagedSkillContent(content: string): boolean {
  return content.includes(MUSE_MANAGED_SKILL_MARKER);
}

export type MuseSkillFileAction = 'created' | 'updated' | 'unchanged';

export type MuseSkillInstallResult =
  | {
      ok: true;
      dir: string;
      actions: Record<MuseSkillId, MuseSkillFileAction>;
      paths: Record<MuseSkillId, string>;
      message: string;
    }
  | {
      ok: false;
      collisionPath: string;
      skillId: MuseSkillId;
      error: string;
    };

export function installMuseSkills(): MuseSkillInstallResult {
  const dir = resolveMuseSkillsDir();
  const expected = new Map<MuseSkillId, string>();
  for (const skillId of MUSE_SKILL_IDS) {
    expected.set(skillId, buildMuseManagedSkillContent(readMuseSkillTemplate(skillId)));
  }

  // Collision pre-check before any write: a same-name user-authored skill
  // (no managed stamp) must never be overwritten, and no sibling may be
  // partially written when one collides.
  for (const skillId of MUSE_SKILL_IDS) {
    const skillPath = path.join(dir, skillId, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const existing = fs.readFileSync(skillPath, 'utf8');
      if (existing !== expected.get(skillId) && !isMuseManagedSkillContent(existing)) {
        return {
          ok: false,
          collisionPath: skillPath,
          skillId,
          error:
            `Muse skill collision: ${skillPath} exists and is not Agent Deck-managed. ` +
            `Move it aside or delete it, then re-run \`agent-deck setup --client muse\`. No skills were changed.`,
        };
      }
    }
  }

  const actions = {} as Record<MuseSkillId, MuseSkillFileAction>;
  const paths = {} as Record<MuseSkillId, string>;
  for (const skillId of MUSE_SKILL_IDS) {
    const skillPath = path.join(dir, skillId, 'SKILL.md');
    paths[skillId] = skillPath;
    const want = expected.get(skillId) as string;
    if (!fs.existsSync(skillPath)) {
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, want, 'utf8');
      actions[skillId] = 'created';
      continue;
    }
    const existing = fs.readFileSync(skillPath, 'utf8');
    if (existing === want) {
      actions[skillId] = 'unchanged';
      continue;
    }
    // Managed but stale (pre-check ruled out user-authored content).
    fs.writeFileSync(skillPath, want, 'utf8');
    actions[skillId] = 'updated';
  }

  const values = MUSE_SKILL_IDS.map((id) => actions[id]);
  const summary = values.every((action) => action === 'unchanged')
    ? `Muse skills already current → ${dir}`
    : `Installed Muse skills → ${dir} (${MUSE_SKILL_IDS.map((id) => `${id}:${actions[id]}`).join(', ')})`;
  return { ok: true, dir, actions, paths, message: summary };
}

export type MuseSkillFileStatus = 'current' | 'missing' | 'stale' | 'collision';

export interface MuseSkillDiagnosis {
  skillId: MuseSkillId;
  path: string;
  status: MuseSkillFileStatus;
}

/** Read-only per-skill freshness. Never writes. */
export function diagnoseMuseSkills(): MuseSkillDiagnosis[] {
  const dir = resolveMuseSkillsDir();
  return MUSE_SKILL_IDS.map((skillId) => {
    const skillPath = path.join(dir, skillId, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      return { skillId, path: skillPath, status: 'missing' };
    }
    const expected = buildMuseManagedSkillContent(readMuseSkillTemplate(skillId));
    const existing = fs.readFileSync(skillPath, 'utf8');
    if (existing === expected) {
      return { skillId, path: skillPath, status: 'current' };
    }
    return {
      skillId,
      path: skillPath,
      status: isMuseManagedSkillContent(existing) ? 'stale' : 'collision',
    };
  });
}

export function summarizeMuseSkillsDiagnosis(
  diagnoses: MuseSkillDiagnosis[] = diagnoseMuseSkills(),
): { status: 'current' | 'missing' | 'stale'; path: string } {
  const dir = resolveMuseSkillsDir();
  const missing = diagnoses.find((diagnosis) => diagnosis.status === 'missing');
  if (missing) {
    return { status: 'missing', path: missing.path };
  }
  const stale = diagnoses.find(
    (diagnosis) => diagnosis.status === 'stale' || diagnosis.status === 'collision',
  );
  if (stale) {
    return { status: 'stale', path: stale.path };
  }
  return { status: 'current', path: dir };
}
