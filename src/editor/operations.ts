import type { TextOperation } from "../api/types";

function charArray(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  // Array.from handles surrogate pairs so character indices match user-visible positions.
  return Array.from(value);
}

export function computeOperations(
  previousText: string,
  nextText: string,
): TextOperation[] {
  if (previousText === nextText) {
    return [];
  }

  const previousChars = charArray(previousText);
  const nextChars = charArray(nextText);

  let prefixLength = 0;
  while (
    prefixLength < previousChars.length &&
    prefixLength < nextChars.length &&
    previousChars[prefixLength] === nextChars[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousChars.length - prefixLength &&
    suffixLength < nextChars.length - prefixLength &&
    previousChars[previousChars.length - 1 - suffixLength] ===
      nextChars[nextChars.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const operations: TextOperation[] = [];

  const deleteCount = previousChars.length - prefixLength - suffixLength;
  if (deleteCount > 0) {
    operations.push({
      type: "delete",
      start_position: prefixLength,
      end_position: prefixLength + deleteCount,
    });
  }

  const insertCount = nextChars.length - prefixLength - suffixLength;
  if (insertCount > 0) {
    const insertedText = nextChars
      .slice(prefixLength, prefixLength + insertCount)
      .join("");
    operations.push({
      type: "insert",
      position: prefixLength,
      text: insertedText,
    });
  }

  return operations;
}

export default computeOperations;
