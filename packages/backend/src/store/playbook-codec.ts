import matter from 'gray-matter';
import {
  StorePlaybookFileSchema,
  type StorePlaybookFile,
} from '@agent-deck/shared';

function frontmatterFromPlaybook(playbook: StorePlaybookFile): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: playbook.id,
    title: playbook.title,
    triggers: playbook.triggers,
    dependsOnCredentialIds: playbook.dependsOnCredentialIds,
    dependsOnServiceIds: playbook.dependsOnServiceIds,
    createdAt: playbook.createdAt,
    updatedAt: playbook.updatedAt,
  };
  if (playbook.exec !== undefined) {
    data.exec = playbook.exec;
  }
  if (playbook.skill !== undefined) {
    data.skill = playbook.skill;
  }
  return data;
}

function normalizeFrontmatterValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function normalizePlaybookBody(content: string): string {
  return content.startsWith('\n') ? content.slice(1) : content;
}

function frontmatterToPlaybook(
  data: Record<string, unknown>,
  body: string,
): StorePlaybookFile {
  const exec = normalizeFrontmatterValue(data.exec);
  const skill = normalizeFrontmatterValue(data.skill);

  return StorePlaybookFileSchema.parse({
    id: data.id,
    title: data.title,
    body: normalizePlaybookBody(body),
    triggers: data.triggers ?? [],
    dependsOnCredentialIds: data.dependsOnCredentialIds ?? [],
    dependsOnServiceIds: data.dependsOnServiceIds ?? [],
    ...(exec != null ? { exec: String(exec) } : {}),
    ...(skill != null ? { skill: String(skill) } : {}),
    createdAt:
      typeof data.createdAt === 'string'
        ? data.createdAt
        : (data.createdAt as Date).toISOString(),
    updatedAt:
      typeof data.updatedAt === 'string'
        ? data.updatedAt
        : (data.updatedAt as Date).toISOString(),
  });
}

export function serializePlaybook(playbook: StorePlaybookFile): string {
  const validated = StorePlaybookFileSchema.parse(playbook);
  return matter.stringify(validated.body, frontmatterFromPlaybook(validated));
}

export function parsePlaybookMarkdown(raw: string): StorePlaybookFile {
  const { data, content } = matter(raw);
  return frontmatterToPlaybook(data as Record<string, unknown>, content);
}
