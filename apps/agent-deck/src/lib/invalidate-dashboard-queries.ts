import type { QueryClient } from "@tanstack/react-query";

/** Refresh dashboard cards after a service changes (OAuth, health, etc.). */
export function invalidateDashboardServiceQueries(
  queryClient: QueryClient,
  serviceId?: string,
) {
  queryClient.invalidateQueries({ queryKey: ["/api/services"] });
  queryClient.invalidateQueries({ queryKey: ["/api/collection/warnings"] });

  if (serviceId) {
    queryClient.invalidateQueries({ queryKey: ["/api/services", serviceId] });
    queryClient.invalidateQueries({ queryKey: ["/api/services", serviceId, "tools"] });
    // NOT-655: the details modal reads the same server auth state as the
    // face badge, so a post-callback service update clears both at once.
    queryClient.invalidateQueries({ queryKey: ["/api/oauth", serviceId, "status"] });
  }
}

export const OAUTH_COMPLETE_MESSAGE = "agent-deck:oauth-complete" as const;

export interface OAuthCompleteMessage {
  type: typeof OAUTH_COMPLETE_MESSAGE;
  serviceId?: string;
}

export function isOAuthCompleteMessage(data: unknown): data is OAuthCompleteMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as OAuthCompleteMessage).type === OAUTH_COMPLETE_MESSAGE
  );
}
