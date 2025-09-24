import { describe, expect, it, vi } from "bun:test";

import MorningCheckInFlow from "../src/checkin/MorningCheckInFlow";

describe("MorningCheckInFlow", () => {
  it("progresses through reflection to dialogue", () => {
    const flow = new MorningCheckInFlow();

    expect(flow.getState()).toBe("idle");
    flow.start();
    expect(flow.getState()).toBe("awaiting_reflection");
    flow.submitReflection("Focused on priorities");
    expect(flow.getState()).toBe("awaiting_dialogue");
  });

  it("builds dialogue prompt using prepare_llm_prompt", () => {
    const preparePrompt = vi.fn().mockReturnValue("prompt");
    const flow = new MorningCheckInFlow({ preparePrompt });

    flow.start();
    flow.submitReflection("Today I will tackle the important tasks");

    const document = "# Timeline";
    const output = flow.buildDialoguePrompt(document);

    expect(preparePrompt).toHaveBeenCalledTimes(1);
    const [queryArg, documentArg] = preparePrompt.mock.calls[0];
    expect(documentArg).toBe(document);
    expect(queryArg).toContain("Today I will tackle the important tasks");
    expect(output).toBe("prompt");
    expect(flow.getState()).toBe("complete");
  });

  it("rejects invalid transitions", () => {
    const flow = new MorningCheckInFlow();

    expect(() => flow.submitReflection("early"))
      .toThrowError(/awaiting_reflection/);

    flow.start();
    expect(() => flow.buildDialoguePrompt("doc"))
      .toThrowError(/awaiting_dialogue/);
  });
});
