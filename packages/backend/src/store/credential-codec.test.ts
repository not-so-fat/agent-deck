import { describe, expect, it } from 'vitest';
import { parseCredentialYaml, serializeCredentialMeta } from './credential-codec';

describe('credential-codec', () => {
  it('round-trips credential metadata', () => {
    const input = {
      id: 'cred_openai',
      label: 'OpenAI',
      scheme: 'bearer' as const,
      headerName: null,
      envName: 'OPENAI_API_KEY',
      tags: ['llm', 'api'],
      docsUrl: 'https://platform.openai.com/docs',
    };
    const raw = serializeCredentialMeta(input);
    expect(raw).toContain('label: "OpenAI"');
    expect(parseCredentialYaml(raw)).toEqual(input);
  });

  it('parses hand-rolled yaml-sync format', () => {
    const raw = `# Agent Deck credential metadata (secret stored in Keychain)
id: cred_ashby
label: "Ashby"
scheme: bearer
header_name: null
env_name: ASHBY_API_KEY
tags: ["recruiting"]
`;
    expect(parseCredentialYaml(raw)).toEqual({
      id: 'cred_ashby',
      label: 'Ashby',
      scheme: 'bearer',
      headerName: null,
      envName: 'ASHBY_API_KEY',
      tags: ['recruiting'],
    });
  });

  it('omits docs_url when undefined', () => {
    const input = {
      id: 'cred_x',
      label: 'X',
      scheme: 'bearer' as const,
      envName: 'X_KEY',
      tags: [] as string[],
    };
    const raw = serializeCredentialMeta(input);
    expect(raw).not.toMatch(/docs_url:/);
  });
});
