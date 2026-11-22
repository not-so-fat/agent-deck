import type { Service } from "@agent-deck/shared";

import type { CollectionCardWarning } from "@/lib/collection-warnings";
import { apiRequest } from "@/lib/queryClient";

/**
 * NOT-655: a Google OAuth card — its MCP URL host ends in `.googleapis.com`.
 * (Mirrors the backend's `isGoogleMcpServiceUrl`; the frontend cannot import
 * backend code.)
 */
export function isGoogleMcpServiceUrl(
  url: string | null | undefined,
): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".googleapis.com");
  } catch {
    return false;
  }
}

/**
 * NOT-655: the card face is in `needs_reconnect` — the collection warning is
 * `oauth_expired` exactly in that state, so the face badge is the auth state.
 */
export function hasNeedsReconnectWarning(
  warnings: CollectionCardWarning[] | undefined,
): boolean {
  return warnings?.some((warning) => warning.kind === "oauth_expired") ?? false;
}

export type ServiceCardClickDeps = {
  getServiceWarnings: (serviceId: string) => CollectionCardWarning[] | undefined;
  openServiceDetails: (service: Service, focusConnect: boolean) => void;
  toast: (args: {
    title: string;
    description?: string;
    variant?: "destructive";
  }) => void;
};

/**
 * NOT-655: one-click re-auth for Google cards. Clicking a Google card face
 * whose auth state is `needs_reconnect` — and which has a client ID on the
 * card, so a saved client may exist — restarts Google sign-in with the saved
 * client instead of opening the setup form.
 *
 * The popup opens synchronously in the click handler so popup blockers do
 * not eat it; the `POST /api/oauth/:id/connect` response then navigates it
 * to the Google authorization URL. When no usable client exists (no client
 * ID on the card, or the server reports missing credentials), the details
 * modal opens with the connect panel focused. Non-Google cards always open
 * the details modal, exactly as before.
 */
export function createServiceCardClickHandler(
  deps: ServiceCardClickDeps,
): (service: Service) => void {
  return (service: Service) => {
    const needsReconnect =
      isGoogleMcpServiceUrl(service.url) &&
      hasNeedsReconnectWarning(deps.getServiceWarnings(service.id));
    if (!needsReconnect) {
      deps.openServiceDetails(service, false);
      return;
    }

    if (!service.oauthClientId?.trim()) {
      deps.openServiceDetails(service, true);
      return;
    }

    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      deps.toast({
        title: "Popup blocked",
        description: "Allow popups for this site, or reconnect from the details view.",
        variant: "destructive",
      });
      deps.openServiceDetails(service, true);
      return;
    }

    void (async () => {
      try {
        const response = await apiRequest(
          "POST",
          `/api/oauth/${service.id}/connect`,
          {},
        );
        const json = (await response.json()) as {
          success?: boolean;
          error?: string;
          data?: { authorizationUrl?: string };
        };
        if (!json.success) {
          throw new Error(json.error || "Could not start Google sign-in.");
        }
        const authorizationUrl = json.data?.authorizationUrl;
        if (!authorizationUrl) {
          throw new Error("No authorization URL returned.");
        }
        popup.location.href = authorizationUrl;
        deps.toast({
          title: "Continue in browser",
          description: "Complete Google sign-in in the new tab, then return here.",
        });
      } catch (error) {
        popup.close();
        deps.openServiceDetails(service, true);
        deps.toast({
          title: "Reconnect failed",
          description:
            error instanceof Error ? error.message : "Unknown error",
          variant: "destructive",
        });
      }
    })();
  };
}
