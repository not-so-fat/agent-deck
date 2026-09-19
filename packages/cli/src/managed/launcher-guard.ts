/**
 * Standalone CJS run by the ~/.local/bin launcher (never imported from an installed version) when
 * `current` has no `.verified` marker. Prints a loadable version dir; if `current` is broken it
 * falls back to the newest intact version and repoints `current`. Mirrors verify-install.ts.
 */
export const LAUNCHER_GUARD_JS = `'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const home = process.argv[2];
const current = path.join(home, 'current');
const versions = path.join(home, 'versions');
const WRAP = ['exports', 'require', 'module', '__filename', '__dirname'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function intact(dir) {
  try {
    if (fs.existsSync(path.join(dir, '.verified'))) return true;
    const scope = path.join(dir, 'node_modules', '@agent-deck');
    if (!fs.existsSync(path.join(scope, 'cli', 'dist', 'bin.js'))) return false;
    for (const pkg of fs.readdirSync(scope)) {
      const dist = path.join(scope, pkg, 'dist');
      if (!fs.existsSync(dist)) continue;
      for (const file of walk(dist, [])) {
        vm.compileFunction(fs.readFileSync(file, 'utf8').replace(/^#!.*/, ''), WRAP, { filename: file });
      }
    }
    try { fs.writeFileSync(path.join(dir, '.verified'), ''); } catch {}
    return true;
  } catch {
    return false;
  }
}

function cmp(a, b) {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

let real;
try { real = fs.realpathSync(current); } catch { real = null; }
if (real && intact(real)) {
  process.stdout.write(real);
  process.exit(0);
}

const candidates = fs.existsSync(versions)
  ? fs.readdirSync(versions, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort(cmp)
  : [];
for (const name of candidates) {
  const dir = path.join(versions, name);
  if (real && dir === real) continue;
  if (!intact(dir)) continue;
  process.stderr.write('agent-deck: ' + (real ? path.basename(real) : 'current') + ' is broken; falling back to ' + name + '. Run: agent-deck upgrade\\n');
  try {
    const tmp = current + '.tmp-' + process.pid;
    fs.symlinkSync(dir, tmp, 'dir');
    fs.renameSync(tmp, current);
  } catch {}
  process.stdout.write(dir);
  process.exit(0);
}
process.exit(1);
`;
