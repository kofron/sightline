import { describe, expect, it } from "bun:test";

import getInitialPrompt, {
  EMPTY_LOG_PROMPT,
  EXISTING_LOG_PROMPT,
} from "../src/reflection/getInitialPrompt";

describe("getInitialPrompt", () => {
  it("returns a welcoming prompt when the daily log is empty", () => {
    expect(getInitialPrompt(true)).toBe(EMPTY_LOG_PROMPT);
  });

  it("encourages exploration when the daily log already has content", () => {
    expect(getInitialPrompt(false)).toBe(EXISTING_LOG_PROMPT);
  });
});
