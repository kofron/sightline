const TIMELINE_DELIMITER = "=== TIMELINE DOCUMENT ===";
const TASK_DELIMITER = "=== TASK ===";
const RESPONSE_DELIMITER = "=== RESPONSE ===";

export function prepare_llm_prompt(query: string, document: string): string {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    throw new Error("query must not be empty");
  }

  return [
    "You are Sightline, a concise assistant for summarising personal notes.",
    "Use only the provided timeline document to ground your response.",
    TIMELINE_DELIMITER,
    document.trimEnd(),
    TASK_DELIMITER,
    `User Query: ${trimmedQuery}`,
    "Generate a direct answer grounded in the timeline.",
    RESPONSE_DELIMITER,
  ]
    .map((line) => line.trimEnd())
    .join("\n\n");
}

export function process_llm_response(response: string): string {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const delimiterIndex = trimmed.indexOf(RESPONSE_DELIMITER);
  let content = trimmed;
  if (delimiterIndex !== -1) {
    content = trimmed.slice(delimiterIndex + RESPONSE_DELIMITER.length);
  }

  if (content.startsWith(":")) {
    content = content.slice(1);
  }

  return content.trim();
}

export { TIMELINE_DELIMITER, TASK_DELIMITER, RESPONSE_DELIMITER };
