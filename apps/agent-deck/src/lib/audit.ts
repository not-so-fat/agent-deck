import { apiRequest } from "@/lib/queryClient";

export type AuditEntry = {
  id: string;
  timestamp: string;
  installationId: string;
  actor: string;
  event: string;
  targetId: string;
  outcome: "succeeded" | "denied";
  reasonCode: string | null;
};

export type AuditPage = {
  success: boolean;
  data: AuditEntry[];
  paging: { limit: number; nextBefore: string | null };
};

export async function listAudit(before?: string): Promise<AuditPage> {
  const params = new URLSearchParams({ limit: "50" });
  if (before) params.set("before", before);
  const response = await apiRequest("GET", `/api/audit?${params.toString()}`);
  return response.json() as Promise<AuditPage>;
}

