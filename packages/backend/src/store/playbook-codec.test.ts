import { describe, expect, it } from 'vitest';
import { parsePlaybookMarkdown, serializePlaybook } from './playbook-codec';

describe('playbook-codec', () => {
  it('round-trips body and frontmatter', () => {
    const input = {
      id: 'pb_demo',
      title: 'Demo',
      body: 'Hello\n\nworld\n',
      triggers: ['demo'],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: ['svc-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const raw = serializePlaybook(input);
    expect(raw.startsWith('---\n')).toBe(true);
    expect(parsePlaybookMarkdown(raw)).toEqual(input);
  });

  it('preserves trailing newline on round-trip', () => {
    const input = {
      id: 'pb_demo',
      title: 'Demo',
      body: 'Hello\n',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(parsePlaybookMarkdown(serializePlaybook(input))).toEqual(input);
  });

  it('omits exec and skill when undefined', () => {
    const input = {
      id: 'pb_demo',
      title: 'Demo',
      body: '',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const raw = serializePlaybook(input);
    expect(raw).not.toMatch(/exec:/);
    expect(raw).not.toMatch(/skill:/);
  });

  it('round-trips more than 16 triggers from legacy rows', () => {
    const triggers = Array.from({ length: 20 }, (_, index) => `trigger ${index}`);
    const input = {
      id: 'pb_legacy',
      title: 'Legacy',
      body: 'Body\n',
      triggers,
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(parsePlaybookMarkdown(serializePlaybook(input))).toEqual(input);
  });

  it('coerces null exec and skill to undefined on parse', () => {
    const raw = `---
id: pb_demo
title: Demo
triggers: []
dependsOnCredentialIds: []
dependsOnServiceIds: []
exec: null
skill: null
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---

Body text
`;
    const parsed = parsePlaybookMarkdown(raw);
    expect(parsed.exec).toBeUndefined();
    expect(parsed.skill).toBeUndefined();
    expect(parsed.body).toBe('Body text\n');
  });
});
