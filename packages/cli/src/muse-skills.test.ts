import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMuseManagedSkillContent,
  diagnoseMuseSkills,
  installMuseSkills,
  isMuseManagedSkillContent,
  MUSE_MANAGED_SKILL_MARKER,
  MUSE_SKILL_IDS,
  readMuseSkillTemplate,
  resolveMuseSkillFile,
  resolveMuseSkillsDir,
  summarizeMuseSkillsDiagnosis,
} from './muse-skills';

describe('muse-skills resources', () => {
  it('loads all three canonical templates from root skills/ in dev', () => {
    for (const id of MUSE_SKILL_IDS) {
      const template = readMuseSkillTemplate(id);
      expect(template).toContain(`name: ${id}`);
      expect(template.length).toBeGreaterThan(100);
    }
  });

  it('stamps managed content without altering the canonical body', () => {
    const template = readMuseSkillTemplate('agent-deck-session');
    const managed = buildMuseManagedSkillContent(template);
    expect(managed.startsWith(template.endsWith('\n') ? template : `${template}\n`)).toBe(true);
    expect(managed).toContain(MUSE_MANAGED_SKILL_MARKER);
    expect(isMuseManagedSkillContent(managed)).toBe(true);
    expect(isMuseManagedSkillContent(template)).toBe(false);
    expect(isMuseManagedSkillContent('# user skill\n')).toBe(false);
  });

  it('buildMuseManagedSkillContent is idempotent-safe (no double marker when already stamped)', () => {
    const template = readMuseSkillTemplate('agent-deck-setup');
    const once = buildMuseManagedSkillContent(template);
    // Stamping an already-stamped file would double the marker, so installers
    // compare for equality first; the builder itself is a pure append.
    expect(once.match(new RegExp(MUSE_MANAGED_SKILL_MARKER, 'g'))?.length).toBe(1);
  });
});

describe('muse-skills XDG paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves through XDG_CONFIG_HOME when set', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-xdg-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-home-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(resolveMuseSkillsDir()).toBe(path.join(xdg, 'muse', 'skills'));
      expect(resolveMuseSkillFile('agent-deck-session')).toBe(
        path.join(xdg, 'muse', 'skills', 'agent-deck-session', 'SKILL.md'),
      );
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      fs.rmSync(xdg, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([{ xdg: undefined }, { xdg: '' }, { xdg: '   ' }])(
    'falls back to ~/.config/muse/skills when XDG_CONFIG_HOME is %j',
    ({ xdg }) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-home-'));
      const previousXdg = process.env.XDG_CONFIG_HOME;
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = xdg;
      try {
        expect(resolveMuseSkillsDir()).toBe(path.join(home, '.config', 'muse', 'skills'));
      } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe('installMuseSkills', () => {
  let tmpHome = '';
  let tmpXdg = '';
  let previousXdg: string | undefined;

  function useTmpXdg(): string {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-install-home-'));
    tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-install-xdg-'));
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpXdg;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    return tmpXdg;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    previousXdg = undefined;
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    if (tmpXdg) fs.rmSync(tmpXdg, { recursive: true, force: true });
    tmpHome = '';
    tmpXdg = '';
  });

  function snapshotTree(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (current: string) => {
      if (!fs.existsSync(current)) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          out.set(path.relative(dir, full), fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(dir);
    return out;
  }

  it('creates all three managed skills on a clean home', () => {
    useTmpXdg();
    const result = installMuseSkills();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toEqual({
      'agent-deck-session': 'created',
      'agent-deck-playbooks': 'created',
      'agent-deck-setup': 'created',
    });
    for (const id of MUSE_SKILL_IDS) {
      const skillPath = path.join(tmpXdg, 'muse', 'skills', id, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, 'utf8');
      expect(content).toBe(buildMuseManagedSkillContent(readMuseSkillTemplate(id)));
      expect(content).toContain(MUSE_MANAGED_SKILL_MARKER);
    }
    // No Muse files leak into the mocked home.
    expect(fs.existsSync(path.join(tmpHome, '.config', 'muse', 'skills'))).toBe(false);
  });

  it('second run performs no content change (idempotent file tree)', () => {
    useTmpXdg();
    const first = installMuseSkills();
    expect(first.ok).toBe(true);
    const before = snapshotTree(path.join(tmpXdg, 'muse', 'skills'));
    expect(before.size).toBe(3);
    const second = installMuseSkills();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.actions).toEqual({
      'agent-deck-session': 'unchanged',
      'agent-deck-playbooks': 'unchanged',
      'agent-deck-setup': 'unchanged',
    });
    const after = snapshotTree(path.join(tmpXdg, 'muse', 'skills'));
    expect(after).toEqual(before);
  });

  it('refreshes stale managed skills and leaves current ones unchanged', () => {
    useTmpXdg();
    expect(installMuseSkills().ok).toBe(true);
    const stalePath = path.join(tmpXdg, 'muse', 'skills', 'agent-deck-session', 'SKILL.md');
    fs.writeFileSync(stalePath, `# stale\n\n${MUSE_MANAGED_SKILL_MARKER}\n`, 'utf8');
    const currentBefore = fs.readFileSync(
      path.join(tmpXdg, 'muse', 'skills', 'agent-deck-playbooks', 'SKILL.md'),
      'utf8',
    );
    const result = installMuseSkills();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions['agent-deck-session']).toBe('updated');
    expect(result.actions['agent-deck-playbooks']).toBe('unchanged');
    expect(result.actions['agent-deck-setup']).toBe('unchanged');
    expect(fs.readFileSync(stalePath, 'utf8')).toBe(
      buildMuseManagedSkillContent(readMuseSkillTemplate('agent-deck-session')),
    );
    expect(
      fs.readFileSync(
        path.join(tmpXdg, 'muse', 'skills', 'agent-deck-playbooks', 'SKILL.md'),
        'utf8',
      ),
    ).toBe(currentBefore);
  });

  it('never overwrites a same-name user-authored skill and changes no bytes', () => {
    useTmpXdg();
    const collisionPath = path.join(tmpXdg, 'muse', 'skills', 'agent-deck-setup', 'SKILL.md');
    fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
    const userBytes = '# My own setup notes\n\nKeep me.\n';
    fs.writeFileSync(collisionPath, userBytes, 'utf8');
    const before = snapshotTree(path.join(tmpXdg, 'muse'));

    const result = installMuseSkills();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.collisionPath).toBe(collisionPath);
    expect(result.error).toContain(collisionPath);
    expect(result.error).toContain('agent-deck setup --client muse');

    // All existing bytes unchanged, and no sibling created.
    expect(fs.readFileSync(collisionPath, 'utf8')).toBe(userBytes);
    expect(snapshotTree(path.join(tmpXdg, 'muse'))).toEqual(before);
    expect(fs.existsSync(path.join(tmpXdg, 'muse', 'skills', 'agent-deck-session'))).toBe(false);
  });
});

describe('diagnoseMuseSkills (read-only)', () => {
  let tmpHome = '';
  let tmpXdg = '';
  let previousXdg: string | undefined;

  function useTmpXdg(): string {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-diag-home-'));
    tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-diag-xdg-'));
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpXdg;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    return tmpXdg;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    previousXdg = undefined;
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    if (tmpXdg) fs.rmSync(tmpXdg, { recursive: true, force: true });
    tmpHome = '';
    tmpXdg = '';
  });

  it('reports missing when no skills exist and creates nothing', () => {
    useTmpXdg();
    const diagnoses = diagnoseMuseSkills();
    expect(diagnoses.map((d) => d.status)).toEqual(['missing', 'missing', 'missing']);
    const summary = summarizeMuseSkillsDiagnosis(diagnoses);
    expect(summary.status).toBe('missing');
    expect(summary.path).toBe(path.join(tmpXdg, 'muse', 'skills', 'agent-deck-session', 'SKILL.md'));
    expect(fs.existsSync(path.join(tmpXdg, 'muse', 'skills'))).toBe(false);
  });

  it('reports stale when one managed skill is outdated and changes nothing', () => {
    useTmpXdg();
    expect(installMuseSkills().ok).toBe(true);
    const stalePath = path.join(tmpXdg, 'muse', 'skills', 'agent-deck-playbooks', 'SKILL.md');
    const staleBytes = `# stale\n\n${MUSE_MANAGED_SKILL_MARKER}\n`;
    fs.writeFileSync(stalePath, staleBytes, 'utf8');
    const diagnoses = diagnoseMuseSkills();
    expect(diagnoses.find((d) => d.skillId === 'agent-deck-playbooks')?.status).toBe('stale');
    const summary = summarizeMuseSkillsDiagnosis(diagnoses);
    expect(summary.status).toBe('stale');
    expect(summary.path).toBe(stalePath);
    expect(fs.readFileSync(stalePath, 'utf8')).toBe(staleBytes);
  });

  it('reports collision as stale (repair via setup surfaces the actionable path)', () => {
    useTmpXdg();
    expect(installMuseSkills().ok).toBe(true);
    const collisionPath = path.join(tmpXdg, 'muse', 'skills', 'agent-deck-setup', 'SKILL.md');
    fs.writeFileSync(collisionPath, '# user-authored\n', 'utf8');
    const diagnoses = diagnoseMuseSkills();
    expect(diagnoses.find((d) => d.skillId === 'agent-deck-setup')?.status).toBe('collision');
    expect(summarizeMuseSkillsDiagnosis(diagnoses)).toEqual({
      status: 'stale',
      path: collisionPath,
    });
    expect(fs.readFileSync(collisionPath, 'utf8')).toBe('# user-authored\n');
  });

  it('reports current only when all three skills are present and current', () => {
    useTmpXdg();
    expect(installMuseSkills().ok).toBe(true);
    expect(diagnoseMuseSkills().every((d) => d.status === 'current')).toBe(true);
    expect(summarizeMuseSkillsDiagnosis().status).toBe('current');
    // Removing one file flips the summary to missing.
    fs.rmSync(path.join(tmpXdg, 'muse', 'skills', 'agent-deck-setup', 'SKILL.md'));
    expect(summarizeMuseSkillsDiagnosis().status).toBe('missing');
  });
});
