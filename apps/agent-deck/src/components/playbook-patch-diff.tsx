import type { PatchPreview } from "@agent-deck/shared";
import { patchPreviewHasChanges } from "@/lib/patch-preview";
import { buildUnifiedDiffRows, hasDiffRows, type DiffRow } from "@/lib/line-diff";

const diffPanelClass =
  "max-w-full overflow-x-auto rounded-md border border-gray-800 bg-gray-950 font-mono text-xs leading-5";

function rowClass(kind: DiffRow["kind"]): string {
  switch (kind) {
    case "added":
      return "bg-emerald-950/70 text-emerald-100";
    case "removed":
      return "bg-rose-950/70 text-rose-100";
    case "ellipsis":
      return "bg-gray-900 text-gray-500 italic";
    default:
      return "bg-gray-950 text-gray-300";
  }
}

function prefixFor(kind: DiffRow["kind"]): string {
  switch (kind) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "ellipsis":
      return "…";
    default:
      return " ";
  }
}

function UnifiedDiffView({ rows, emptyLabel }: { rows: DiffRow[]; emptyLabel: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-500">{emptyLabel}</p>;
  }

  return (
    <div className={diffPanelClass}>
      {rows.map((row, index) => (
        <div
          key={`${row.kind}-${index}-${row.oldLine ?? ""}-${row.newLine ?? ""}`}
          className={`grid min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] gap-0 ${rowClass(row.kind)}`}
        >
          <span className="select-none border-r border-gray-800/80 px-2 py-0.5 text-right text-gray-600">
            {row.oldLine ?? ""}
          </span>
          <span className="select-none border-r border-gray-800/80 px-2 py-0.5 text-right text-gray-600">
            {row.newLine ?? ""}
          </span>
          <div className="flex min-w-0 gap-2 px-2 py-0.5">
            <span className="w-3 shrink-0 select-none text-gray-500">{prefixFor(row.kind)}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{row.text || " "}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TriggerDiff({ before, after }: { before: string[]; after: string[] }) {
  const removed = before.filter((trigger) => !after.includes(trigger));
  const added = after.filter((trigger) => !before.includes(trigger));

  if (removed.length === 0 && added.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-gray-400">Triggers</h4>
      <div className={`${diffPanelClass} p-0`}>
        {removed.map((trigger) => (
          <div
            key={`removed-${trigger}`}
            className="grid min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] bg-rose-950/70 text-rose-100"
          >
            <span className="border-r border-gray-800/80 px-2 py-0.5" />
            <span className="border-r border-gray-800/80 px-2 py-0.5" />
            <div className="flex gap-2 px-2 py-0.5">
              <span className="w-3 shrink-0 text-gray-500">-</span>
              <span>{trigger}</span>
            </div>
          </div>
        ))}
        {added.map((trigger) => (
          <div
            key={`added-${trigger}`}
            className="grid min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] bg-emerald-950/70 text-emerald-100"
          >
            <span className="border-r border-gray-800/80 px-2 py-0.5" />
            <span className="border-r border-gray-800/80 px-2 py-0.5" />
            <div className="flex gap-2 px-2 py-0.5">
              <span className="w-3 shrink-0 text-gray-500">+</span>
              <span>{trigger}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlaybookPatchDiff({ preview }: { preview: PatchPreview }) {
  const hasChanges = patchPreviewHasChanges(preview);
  const bodyRows = buildUnifiedDiffRows(preview.before.body, preview.after.body);
  const rewrite =
    preview.before.body.trim() !== preview.after.body.trim() &&
    preview.after.body.length > 0 &&
    !preview.after.body.includes(preview.before.body.slice(0, 40)) &&
    hasDiffRows(bodyRows);

  const titleChanged = preview.before.title !== preview.after.title;
  const triggersChanged =
    preview.before.triggers.join("\n") !== preview.after.triggers.join("\n");

  return (
    <div className="min-w-0 space-y-4">
      {!hasChanges && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-100">
          No change detected — ops did not alter the playbook body or triggers. Reject this
          proposal and re-propose with a matching list anchor or <code>rewrite_body</code>.
        </div>
      )}
      {rewrite && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-100">
          Full-body rewrite proposed — review carefully.
        </div>
      )}

      {titleChanged && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-400">Title</h4>
          <div className={`${diffPanelClass} p-0`}>
            {preview.before.title && (
              <div className="grid min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] bg-rose-950/70 text-rose-100">
                <span className="border-r border-gray-800/80 px-2 py-0.5" />
                <span className="border-r border-gray-800/80 px-2 py-0.5" />
                <div className="flex gap-2 px-2 py-0.5">
                  <span className="w-3 shrink-0 text-gray-500">-</span>
                  <span>{preview.before.title}</span>
                </div>
              </div>
            )}
            {preview.after.title && (
              <div className="grid min-w-0 grid-cols-[3rem_3rem_minmax(0,1fr)] bg-emerald-950/70 text-emerald-100">
                <span className="border-r border-gray-800/80 px-2 py-0.5" />
                <span className="border-r border-gray-800/80 px-2 py-0.5" />
                <div className="flex gap-2 px-2 py-0.5">
                  <span className="w-3 shrink-0 text-gray-500">+</span>
                  <span>{preview.after.title}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-gray-400">Body</h4>
        <UnifiedDiffView rows={bodyRows} emptyLabel="No body changes." />
      </div>

      {triggersChanged && (
        <TriggerDiff before={preview.before.triggers} after={preview.after.triggers} />
      )}
    </div>
  );
}
