import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/queryClient";
import { createDeckErrorToast } from "@/lib/create-deck-error";

describe("createDeckErrorToast", () => {
  it("surfaces duplicate name clearly", () => {
    expect(createDeckErrorToast(new Error("A deck with that name already exists"))).toEqual({
      title: "Deck name already exists",
      description: "Choose a different name — a deck with that name already exists.",
    });
  });

  it("surfaces missing dashboard session", () => {
    expect(
      createDeckErrorToast(new ApiError("No deck selected", 401, "GRANT_REQUIRED")),
    ).toMatchObject({
      title: "Dashboard session required",
    });
  });

  it("surfaces file-store write failures", () => {
    expect(
      createDeckErrorToast(new Error("Failed to write deck to file store: ENOSPC")),
    ).toMatchObject({
      title: "Could not save deck",
    });
  });
});
