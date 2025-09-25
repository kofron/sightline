import { describe, expect, it } from "bun:test";

import computeOperations from "../src/editor/operations";

describe("computeOperations", () => {
  it("returns insert operation for appended text", () => {
    const ops = computeOperations("Hello", "Hello world");
    expect(ops).toEqual([
      {
        type: "insert",
        position: 5,
        text: " world",
      },
    ]);
  });

  it("returns delete operation for removed range", () => {
    const ops = computeOperations("Hello world", "Hello");
    expect(ops).toEqual([
      {
        type: "delete",
        start_position: 5,
        end_position: 11,
      },
    ]);
  });

  it("detects replacement around shared prefix and suffix", () => {
    const ops = computeOperations("Meeting notes", "Meeting summary");
    expect(ops).toEqual([
      {
        type: "delete",
        start_position: 8,
        end_position: 13,
      },
      {
        type: "insert",
        position: 8,
        text: "summary",
      },
    ]);
  });

  it("handles markdown formatting expansion", () => {
    const ops = computeOperations("Hello world", "Hello **world**");
    expect(ops).toEqual([
      {
        type: "delete",
        start_position: 6,
        end_position: 11,
      },
      {
        type: "insert",
        position: 6,
        text: "**world**",
      },
    ]);
  });
});
