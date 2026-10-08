import { describe, expect, it } from 'vitest';
import {
  BundleAnySchema,
  BundleDeckV2Schema,
  BundleV1Schema,
  BundleV2Schema,
  ExportRequestSchema,
  ImportReportSchema,
} from './export-bundle';
import { OPERATING_INSTRUCTIONS_MAX_LENGTH } from './deck';

const validBundle = {
  format: 'agent-deck-bundle' as const,
  version: 1 as const,
  exportedAt: '2026-07-03T00:00:00.000Z',
  exportedFrom: { agentDeckVersion: '1.3.0' },
  scope: 'collection' as const,
  services: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Linear',
      type: 'mcp' as const,
      url: 'https://mcp.linear.app/mcp',
    },
  ],
  playbooks: [
    {
      id: 'pb_example',
      title: 'Example',
      body: 'Do the thing',
      triggers: ['example'],
      dependsOnServiceIds: ['11111111-1111-4111-8111-111111111111'],
    },
  ],
  decks: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'dev',
      serviceIds: ['11111111-1111-4111-8111-111111111111'],
      playbookIds: ['pb_example'],
    },
  ],
};

describe('BundleV1Schema', () => {
  it('accepts a valid collection bundle', () => {
    const result = BundleV1Schema.safeParse(validBundle);
    expect(result.success).toBe(true);
  });

  it('rejects unknown format', () => {
    const result = BundleV1Schema.safeParse({ ...validBundle, format: 'other' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown version', () => {
    const result = BundleV1Schema.safeParse({ ...validBundle, version: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects credential-shaped fields on services (strict)', () => {
    const result = BundleV1Schema.safeParse({
      ...validBundle,
      services: [
        {
          ...validBundle.services[0],
          credentialId: 'cred_x',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects secret-shaped fields on services (strict)', () => {
    for (const field of [
      'oauthClientSecret',
      'oauthAccessToken',
      'oauthRefreshToken',
      'localEnv',
    ]) {
      const result = BundleV1Schema.safeParse({
        ...validBundle,
        services: [
          {
            ...validBundle.services[0],
            [field]: field === 'localEnv' ? { API_KEY: 'x' } : 'secret',
          },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects credentials array on bundle (strict)', () => {
    const result = BundleV1Schema.safeParse({
      ...validBundle,
      credentials: [{ id: 'cred_x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid playbook id', () => {
    const result = BundleV1Schema.safeParse({
      ...validBundle,
      playbooks: [{ id: 'not-a-playbook', title: 'X', body: '', triggers: [] }],
    });
    expect(result.success).toBe(false);
  });
});

describe('BundleV2Schema', () => {
  const validV2Bundle = {
    ...validBundle,
    version: 2 as const,
    decks: [
      {
        ...validBundle.decks[0],
        operatingInstructions: '# Dev runbook\nPrefer small PRs.\n',
      },
    ],
  };

  it('accepts a valid v2 bundle with deck instructions', () => {
    const result = BundleV2Schema.safeParse(validV2Bundle);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(2);
      expect(result.data.decks[0].operatingInstructions).toBe(
        '# Dev runbook\nPrefer small PRs.\n',
      );
    }
  });

  it('accepts the documented PRD §7.1 v2 example', () => {
    const result = BundleV2Schema.safeParse({
      format: 'agent-deck-bundle',
      version: 2,
      exportedAt: '2026-07-03T00:00:00.000Z',
      exportedFrom: { agentDeckVersion: '1.3.0' },
      scope: 'collection',
      services: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Linear',
          type: 'mcp',
          url: 'https://mcp.linear.app/mcp',
          description: 'optional',
          cardColor: '#92E4DD',
          disabledToolNames: [],
          oauthClientId: 'optional-public',
          oauthAuthorizationUrl: 'https://example.com/oauth/authorize',
          oauthTokenUrl: 'https://example.com/oauth/token',
          oauthRedirectUri: 'https://example.com/callback',
          oauthScope: 'read',
          localCommand: 'optional',
          localArgs: [],
          localWorkingDir: 'optional',
          headers: { 'X-Custom': 'ok' },
        },
      ],
      playbooks: [
        {
          id: 'pb_example',
          title: 'Example',
          body: '…',
          triggers: ['example'],
          dependsOnServiceIds: ['11111111-1111-4111-8111-111111111111'],
          exec: 'optional',
          skill: 'optional',
        },
      ],
      decks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'dev',
          operatingInstructions: '# Dev runbook\nPrefer small PRs.\n',
          serviceIds: ['11111111-1111-4111-8111-111111111111'],
          playbookIds: ['pb_example'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults missing v2 deck instructions to empty', () => {
    const result = BundleDeckV2Schema.safeParse({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'dev',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.operatingInstructions).toBe('');
      expect(result.data.serviceIds).toEqual([]);
      expect(result.data.playbookIds).toEqual([]);
    }
  });

  it('rejects v2 instructions over the shared Deck-model bound', () => {
    const over = 'x'.repeat(OPERATING_INSTRUCTIONS_MAX_LENGTH + 1);
    const result = BundleV2Schema.safeParse({
      ...validV2Bundle,
      decks: [{ ...validV2Bundle.decks[0], operatingInstructions: over }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([
        'decks',
        0,
        'operatingInstructions',
      ]);
    }
  });

  it('rejects malformed v2 deck records', () => {
    for (const decks of [
      [{ id: 'x', serviceIds: [], playbookIds: [] }],
      [{ id: '', name: 'dev' }],
      [{ id: 'x', name: 'dev', operatingInstructions: 42 }],
    ]) {
      expect(
        BundleV2Schema.safeParse({ ...validV2Bundle, decks }).success,
      ).toBe(false);
    }
  });

  it('keeps the v1 secret boundary on services (strict)', () => {
    for (const field of [
      'oauthClientSecret',
      'oauthAccessToken',
      'oauthRefreshToken',
      'localEnv',
      'credentialId',
    ]) {
      const result = BundleV2Schema.safeParse({
        ...validV2Bundle,
        services: [
          {
            ...validV2Bundle.services[0],
            [field]: field === 'localEnv' ? { API_KEY: 'x' } : 'secret',
          },
        ],
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('BundleAnySchema', () => {
  it('accepts v1 bundles (no instructions carried)', () => {
    const result = BundleAnySchema.safeParse(validBundle);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
    }
  });

  it('accepts v2 bundles', () => {
    const result = BundleAnySchema.safeParse({
      ...validBundle,
      version: 2,
      decks: [
        {
          ...validBundle.decks[0],
          operatingInstructions: 'Runbook\n',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(2);
    }
  });

  it('rejects unknown versions and formats', () => {
    expect(
      BundleAnySchema.safeParse({ ...validBundle, version: 3 }).success,
    ).toBe(false);
    expect(
      BundleAnySchema.safeParse({ ...validBundle, format: 'other' }).success,
    ).toBe(false);
  });
});

describe('ExportRequestSchema', () => {
  it('defaults scope to collection', () => {
    const result = ExportRequestSchema.parse({});
    expect(result.scope).toBe('collection');
  });

  it('requires deckId when scope is deck', () => {
    const result = ExportRequestSchema.safeParse({ scope: 'deck' });
    expect(result.success).toBe(false);
  });

  it('accepts deck scope with deckId', () => {
    const result = ExportRequestSchema.safeParse({
      scope: 'deck',
      deckId: '22222222-2222-4222-8222-222222222222',
    });
    expect(result.success).toBe(true);
  });
});

describe('ImportReportSchema', () => {
  it('accepts a completed report', () => {
    const result = ImportReportSchema.safeParse({
      status: 'completed',
      counts: {
        services: { created: 1, reused: 0 },
        playbooks: { created: 0, reused: 1 },
        decks: { created: 1, reused: 0 },
      },
      servicesNeedingOauth: ['Linear'],
      warnings: [],
      idMap: { a: 'b' },
    });
    expect(result.success).toBe(true);
  });
});
