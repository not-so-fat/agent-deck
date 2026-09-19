import { ApiError } from "@/lib/queryClient";

/** Map create-deck API failures to actionable toast copy (NOT-153). */
export function createDeckErrorToast(error: Error): { title: string; description: string } {
  const message = error.message || "Unknown error";
  if (/already exists/i.test(message)) {
    return {
      title: "Deck name already exists",
      description: "Choose a different name — a deck with that name already exists.",
    };
  }
  if (error instanceof ApiError) {
    if (error.errorCode === "GRANT_REQUIRED" || error.errorCode === "DASHBOARD_REQUIRED") {
      return {
        title: "Dashboard session required",
        description:
          "Your dashboard session is missing or expired. Run agent-deck open and try again.",
      };
    }
    if (error.errorCode === "ADMIN_REQUIRED") {
      return {
        title: "Admin elevation required",
        description: "Deck-admin elevation is required for this agent session.",
      };
    }
  }
  if (/file store/i.test(message)) {
    return {
      title: "Could not save deck",
      description: message,
    };
  }
  return {
    title: "Failed to create deck",
    description: message,
  };
}
