const EMPTY_LOG_PROMPT = "Good morning! What's on your mind today?";
const EXISTING_LOG_PROMPT = "Welcome back! What would you like to explore from today?";

export default function getInitialPrompt(isDailyLogEmpty: boolean): string {
  return isDailyLogEmpty ? EMPTY_LOG_PROMPT : EXISTING_LOG_PROMPT;
}

export { EMPTY_LOG_PROMPT, EXISTING_LOG_PROMPT };
