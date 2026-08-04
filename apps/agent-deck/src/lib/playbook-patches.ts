import type { ApiResponse, PatchPreview, PlaybookPatch, PlaybookPatchListItem } from "@agent-deck/shared";
import { apiRequest } from "@/lib/queryClient";

async function parseApi<T>(res: Response): Promise<T> {
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.success) {
    throw new Error(body.error ?? "Request failed");
  }
  return body.data as T;
}

export function formatPatchDeckNames(deckNames: string[]): string | null {
  if (deckNames.length === 0) return null;
  if (deckNames.length <= 3) return deckNames.join(", ");
  return `${deckNames.slice(0, 3).join(", ")} and ${deckNames.length - 3} more`;
}

export async function listPlaybookPatches(
  status?: PlaybookPatch["status"],
): Promise<PlaybookPatchListItem[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await apiRequest("GET", `/api/playbook-patches${qs}`);
  return parseApi<PlaybookPatchListItem[]>(res);
}

export async function getPlaybookPatchPreview(id: string): Promise<PatchPreview> {
  const res = await apiRequest("GET", `/api/playbook-patches/${id}/preview`);
  return parseApi<PatchPreview>(res);
}

export async function acceptPlaybookPatch(id: string): Promise<PlaybookPatch> {
  const res = await apiRequest("POST", `/api/playbook-patches/${id}/accept`);
  return parseApi<PlaybookPatch>(res);
}

export async function rejectPlaybookPatch(
  id: string,
  reason?: string,
): Promise<PlaybookPatch> {
  const trimmed = reason?.trim();
  const res = await apiRequest(
    "POST",
    `/api/playbook-patches/${id}/reject`,
    trimmed ? { reason: trimmed } : {},
  );
  return parseApi<PlaybookPatch>(res);
}

export async function getPlaybookFetchCount(playbookId: string): Promise<number> {
  const res = await apiRequest("GET", `/api/playbooks/${playbookId}/events/count`);
  return parseApi<number>(res);
}
