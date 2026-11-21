import { describe, expect, it } from "vitest"
import { cn } from "./utils"

describe("cn (tailwind-merge)", () => {
  it("lets a caller's font size drop a primitive's leading-none, as with tailwind-merge v2", () => {
    expect(cn("text-lg font-semibold leading-none", "text-xl font-bold")).toBe("text-xl font-bold")
  })

  it("keeps an explicit leading that comes after the font size", () => {
    expect(cn("leading-none", "text-sm leading-6")).toBe("text-sm leading-6")
  })
})
