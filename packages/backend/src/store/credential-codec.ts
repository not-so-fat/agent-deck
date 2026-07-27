import YAML from 'yaml';
import {
  StoreCredentialMetaSchema,
  type StoreCredentialMeta,
} from '@agent-deck/shared';

type YamlCredentialPayload = {
  id?: unknown;
  label?: unknown;
  scheme?: unknown;
  header_name?: unknown;
  headerName?: unknown;
  env_name?: unknown;
  envName?: unknown;
  tags?: unknown;
  docs_url?: unknown;
  docsUrl?: unknown;
};

function yamlPayloadToStoreMeta(payload: YamlCredentialPayload): StoreCredentialMeta {
  const headerName =
    payload.header_name !== undefined
      ? payload.header_name
      : payload.headerName;
  const docsUrl =
    payload.docs_url !== undefined ? payload.docs_url : payload.docsUrl;

  const parsed: Record<string, unknown> = {
    id: payload.id,
    label: payload.label,
    scheme: payload.scheme,
    envName: payload.env_name ?? payload.envName,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
  };
  if (headerName !== undefined) {
    parsed.headerName = headerName;
  }
  if (docsUrl !== undefined) {
    parsed.docsUrl = docsUrl;
  }
  return StoreCredentialMetaSchema.parse(parsed);
}

export function serializeCredentialMeta(credential: StoreCredentialMeta): string {
  const validated = StoreCredentialMetaSchema.parse(credential);
  const headerName = validated.headerName ?? null;

  const lines = [
    '# Agent Deck credential metadata (secret stored in Keychain)',
    `id: ${validated.id}`,
    `label: ${JSON.stringify(validated.label)}`,
    `scheme: ${validated.scheme}`,
    `header_name: ${headerName === null ? 'null' : JSON.stringify(headerName)}`,
    `env_name: ${validated.envName}`,
    `tags: [${validated.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
    ...(validated.docsUrl
      ? [`docs_url: ${JSON.stringify(validated.docsUrl)}`]
      : []),
    '',
  ];

  return lines.join('\n');
}

export function parseCredentialYaml(raw: string): StoreCredentialMeta {
  const withoutComments = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const payload = YAML.parse(withoutComments) as YamlCredentialPayload | null;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid credential YAML: expected mapping');
  }
  return yamlPayloadToStoreMeta(payload);
}
