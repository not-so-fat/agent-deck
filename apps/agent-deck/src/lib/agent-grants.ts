import { apiRequest } from "@/lib/queryClient";

export type AgentGrant = {
  id: string;
  label: string;
  defaultDeck: string;
  allowedDecks: string[];
  installationId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type AgentGrantListResponse = {
  success: boolean;
  data: AgentGrant[];
};

export type CreateAgentGrantInput = {
  label: string;
  defaultDeck: string;
  allowedDecks: string[];
  expiresAt?: string;
};

export type IssuedAgentGrant = {
  grant: AgentGrant;
  token: string;
};

export async function createAgentGrant(
  input: CreateAgentGrantInput,
): Promise<IssuedAgentGrant> {
  const response = await apiRequest("POST", "/api/agent-grants", input);
  const body = (await response.json()) as {
    success: boolean;
    data: IssuedAgentGrant;
  };
  return body.data;
}

export async function revokeAgentGrant(id: string): Promise<void> {
  await apiRequest("POST", `/api/agent-grants/${encodeURIComponent(id)}/revoke`);
}

