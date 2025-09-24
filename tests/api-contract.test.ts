import { describe, expect, it } from "bun:test";

import type { EditResponse } from "../src/api/types";

describe("api contract", () => {
  it("matches Rust JSON payload", () => {
    const json = "{\"status\":\"ok\",\"new_version\":42}";
    const parsed = JSON.parse(json) as EditResponse;

    expect(parsed).toEqual({ status: "ok", new_version: 42 });
  });
});
