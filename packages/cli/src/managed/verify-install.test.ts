import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyInstalledVersion } from './verify-install';

describe('verifyInstalledVersion', () => {
  let tmp: string;
  const write = (rel: string, body: string) => {
    const file = path.join(tmp, 'node_modules', '@agent-deck', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-verify-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts valid CJS, including top-level return and a shebang', () => {
    write('cli/dist/bin.js', '#!/usr/bin/env node\nmodule.exports = 1;\n');
    write('shared/dist/a.js', 'if (x) { return; }\nexports.a = 1;\n');
    expect(verifyInstalledVersion(tmp)).toEqual({ ok: true });
  });

  it('reports the truncated file', () => {
    write('cli/dist/bin.js', 'ok\n');
    const bad = write('shared/dist/utils/w.js', 'for (const s of xs) {\n  const warnings = ');
    const result = verifyInstalledVersion(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.file).toBe(bad);
    }
  });

  it('fails when the @agent-deck scope is missing', () => {
    expect(verifyInstalledVersion(tmp).ok).toBe(false);
  });
});
