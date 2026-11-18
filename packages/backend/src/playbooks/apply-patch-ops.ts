import type { PatchOp } from '@agent-deck/shared';

export type PlaybookPatchState = {
  body: string;
  triggers: string[];
};

export type ApplyPatchOpsResult =
  | { ok: true; value: PlaybookPatchState }
  | { ok: false; conflict: string };

type Section = {
  name: string;
  lines: string[];
};

function parseSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split('\n');
  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: Section | null = null;
  let inPreamble = true;

  for (const line of lines) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      inPreamble = false;
      if (current) sections.push(current);
      current = { name: headerMatch[1], lines: [] };
      continue;
    }
    if (inPreamble) {
      preamble.push(line);
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  return { preamble: preamble.join('\n'), sections };
}

function serializeSections(preamble: string, sections: Section[]): string {
  const parts: string[] = [];
  const trimmedPreamble = preamble.trimEnd();
  if (trimmedPreamble) parts.push(trimmedPreamble);

  for (const section of sections) {
    parts.push(`## ${section.name}`);
    // Trim blank edges: parsed lines keep the blank line after the heading and
    // before the next one, and the '\n\n' join below re-adds spacing — without
    // trimming, every apply inflates the body by one blank line per section.
    const lines = [...section.lines];
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) parts.push(lines.join('\n'));
  }

  return parts.join('\n\n') + (parts.length > 0 ? '\n' : '');
}

function findSection(sections: Section[], name: string): Section | undefined {
  const normalized = name.trim().toLowerCase();
  return sections.find((s) => s.name.trim().toLowerCase() === normalized);
}

function formatListItem(text: string): string {
  const trimmed = text.trim();
  if (/^(-|\d+\.)\s/.test(trimmed)) return trimmed;
  return `- ${trimmed}`;
}

function isListItemLine(line: string): boolean {
  return /^(-|\d+\.)\s/.test(line.trim());
}

function applyBodyOp(state: PlaybookPatchState, op: PatchOp): ApplyPatchOpsResult {
  if (op.op === 'rewrite_body') {
    return { ok: true, value: { ...state, body: op.text } };
  }
  if (op.op === 'set_triggers') {
    return { ok: true, value: { ...state, triggers: [...op.triggers] } };
  }

  const parsed = parseSections(state.body);
  const sections = parsed.sections.map((s) => ({ name: s.name, lines: [...s.lines] }));

  if (op.op === 'add_item') {
    let section = findSection(sections, op.section);
    if (!section) {
      section = { name: op.section, lines: [] };
      sections.push(section);
    }
    // Insert before any trailing blank lines so the new item stays adjacent to the list.
    let insertAt = section.lines.length;
    while (insertAt > 0 && section.lines[insertAt - 1].trim() === '') insertAt -= 1;
    section.lines.splice(insertAt, 0, formatListItem(op.text));
    return {
      ok: true,
      value: { ...state, body: serializeSections(parsed.preamble, sections) },
    };
  }

  const section = findSection(sections, op.section);
  if (!section) {
    return { ok: false, conflict: `Section "${op.section}" not found` };
  }

  if (op.op === 'amend_item' || op.op === 'remove_item') {
    const index = section.lines.findIndex((line) => line === op.anchor);
    if (index === -1) {
      return {
        ok: false,
        conflict: `Anchor not found in section "${op.section}": ${op.anchor}. amend_item/remove_item require an exact list item line (- or 1. prefix). Use add_item for new bullets or rewrite_body for prose edits.`,
      };
    }
    const matched = section.lines[index];
    if (!isListItemLine(matched)) {
      return {
        ok: false,
        conflict: `Anchor in section "${op.section}" must be a list item line (- or 1. prefix), not prose or headings. Use add_item for new bullets or rewrite_body for prose edits.`,
      };
    }
    if (op.op === 'amend_item') {
      section.lines[index] = formatListItem(op.text);
    } else {
      section.lines.splice(index, 1);
    }
    return {
      ok: true,
      value: { ...state, body: serializeSections(parsed.preamble, sections) },
    };
  }

  return { ok: false, conflict: `Unsupported op: ${(op as PatchOp).op}` };
}

/** All-or-nothing: any conflict aborts the whole batch. */
export function applyPatchOps(
  initial: PlaybookPatchState,
  ops: PatchOp[],
): ApplyPatchOpsResult {
  let state = { ...initial, triggers: [...initial.triggers] };
  for (const op of ops) {
    const result = applyBodyOp(state, op);
    if (!result.ok) return result;
    state = result.value;
  }
  return { ok: true, value: state };
}
