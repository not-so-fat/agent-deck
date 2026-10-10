#!/usr/bin/env node
/**
 * Copy the canonical root skills/ sources into the CLI dist output so the
 * published @agent-deck/cli tarball ships the Muse bootstrap skills without
 * a second hand-maintained copy (NOT-388).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const skills = ['agent-deck-session', 'agent-deck-playbooks', 'agent-deck-setup'];
const destRoot = path.join(root, 'packages', 'cli', 'dist', 'muse-skills');

for (const id of skills) {
  const src = path.join(root, 'skills', id, 'SKILL.md');
  const dest = path.join(destRoot, id, 'SKILL.md');
  if (!fs.existsSync(src)) {
    console.error(`[copy-muse-skills] Missing canonical source: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-muse-skills] ${src} -> ${dest}`);
}
