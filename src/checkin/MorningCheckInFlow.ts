import { prepare_llm_prompt } from "../llm/prompt";

export type MorningCheckInState =
  | "idle"
  | "awaiting_reflection"
  | "awaiting_dialogue"
  | "complete";

export interface MorningCheckInFlowOptions {
  preparePrompt?: typeof prepare_llm_prompt;
}

export class MorningCheckInFlow {
  private state: MorningCheckInState = "idle";

  private reflection: string | null = null;

  private readonly preparePrompt: typeof prepare_llm_prompt;

  constructor(options: MorningCheckInFlowOptions = {}) {
    const { preparePrompt = prepare_llm_prompt } = options;
    this.preparePrompt = preparePrompt;
  }

  getState(): MorningCheckInState {
    return this.state;
  }

  start(): void {
    if (this.state !== "idle") {
      throw new Error(`cannot start from state ${this.state}`);
    }
    this.state = "awaiting_reflection";
  }

  submitReflection(reflection: string): void {
    if (this.state !== "awaiting_reflection") {
      throw new Error("reflection can only be submitted during awaiting_reflection state");
    }
    const trimmed = reflection.trim();
    if (trimmed.length === 0) {
      throw new Error("reflection must not be empty");
    }

    this.reflection = trimmed;
    this.state = "awaiting_dialogue";
  }

  buildDialoguePrompt(timelineDocument: string): string {
    if (this.state !== "awaiting_dialogue") {
      throw new Error("dialogue prompt is only available during awaiting_dialogue state");
    }
    if (!this.reflection) {
      throw new Error("reflection missing");
    }

    const query = [
      "The user is performing a guided morning check-in.",
      "Use their reflection to craft a short conversational reply and daily plan.",
      "Reflection:",
      this.reflection,
    ].join("\n");

    this.state = "complete";
    return this.preparePrompt(query, timelineDocument);
  }

  reset(): void {
    this.state = "idle";
    this.reflection = null;
  }
}

export default MorningCheckInFlow;
