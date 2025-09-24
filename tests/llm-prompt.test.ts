import { describe, expect, it } from "bun:test";

import {
  prepare_llm_prompt,
  process_llm_response,
  RESPONSE_DELIMITER,
  TASK_DELIMITER,
  TIMELINE_DELIMITER,
} from "../src/llm/prompt";

describe("prepare_llm_prompt", () => {
  it("formats query and document into structured prompt", () => {
    const prompt = prepare_llm_prompt("What did I plan yesterday?", "# Timeline\nEntry");

    expect(prompt).toContain(TIMELINE_DELIMITER);
    expect(prompt).toContain(TASK_DELIMITER);
    expect(prompt).toContain(RESPONSE_DELIMITER);
    expect(prompt).toContain("# Timeline\nEntry");
    expect(prompt).toMatch(/User Query: What did I plan yesterday\?/);
  });

  it("rejects empty queries", () => {
    expect(() => prepare_llm_prompt("   ", "doc"))
      .toThrowError("query must not be empty");
  });
});

describe("process_llm_response", () => {
  it("extracts content following response delimiter", () => {
    const response = `${RESPONSE_DELIMITER}\nAnswer: Stay focused.`;
    const result = process_llm_response(response);
    expect(result).toBe("Answer: Stay focused.");
  });

  it("trims leading colon after delimiter", () => {
    const response = `${RESPONSE_DELIMITER}: Use bullet points.`;
    const result = process_llm_response(response);
    expect(result).toBe("Use bullet points.");
  });

  it("returns trimmed response when delimiter missing", () => {
    const result = process_llm_response("\n\nFinal thoughts\n");
    expect(result).toBe("Final thoughts");
  });
});
