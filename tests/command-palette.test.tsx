import { describe, expect, it } from "bun:test";

import { normalizeDateInput } from "../src/components/CommandPalette";

describe("CommandPalette helpers", () => {
  it("normalizes ISO-like date strings", () => {
    expect(normalizeDateInput("2024-09-26")).toBe("2024-09-26");
    expect(normalizeDateInput("20240926")).toBe("2024-09-26");
    expect(normalizeDateInput("not a date")).toBeNull();
  });

  it("rejects invalid month/day combinations", () => {
    expect(normalizeDateInput("2024-13-01")).toBeNull();
    expect(normalizeDateInput("2024-00-10")).toBeNull();
  });
});
