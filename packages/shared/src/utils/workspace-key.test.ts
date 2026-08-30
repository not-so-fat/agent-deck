import { describe, expect, it } from 'vitest';

import {
  canonicalizeWorkspacePath,
  digestCanonicalWorkspacePath,
} from './workspace-key';

describe('canonicalizeWorkspacePath', () => {
  it('normalizes trailing separators', () => {
    const root = canonicalizeWorkspacePath('/tmp/agent-deck/');
    expect(root.endsWith('/')).toBe(false);
    expect(root).toContain('agent-deck');
  });

  it('applies NFC normalization', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'caf\u0065\u0301';
    expect(canonicalizeWorkspacePath(composed)).toBe(canonicalizeWorkspacePath(decomposed));
  });

  it('produces stable digests for equivalent paths', () => {
    const a = digestCanonicalWorkspacePath(canonicalizeWorkspacePath('/tmp/foo'));
    const b = digestCanonicalWorkspacePath(canonicalizeWorkspacePath('/tmp/foo/'));
    expect(a).toBe(b);
  });
});
