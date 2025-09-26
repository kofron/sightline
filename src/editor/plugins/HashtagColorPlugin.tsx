import { useCallback, useEffect, useMemo } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import { HashtagNode } from "@lexical/hashtag";

import { useTagStore } from "@/lib/tag-store";

const HASHTAG_SELECTOR = ".timeline-editor__hashtag";

export default function HashtagColorPlugin() {
  const [editor] = useLexicalComposerContext();
  const { tags } = useTagStore();

  const palette = useMemo(() => {
    const map = new Map<string, string>();
    for (const descriptor of tags.values()) {
      map.set(descriptor.name.toLowerCase(), descriptor.color);
    }
    return map;
  }, [tags]);

  const applyColors = useCallback((): void => {
    const root = editor.getRootElement();
    if (!root) {
      return;
    }

    const elements = root.querySelectorAll<HTMLElement>(HASHTAG_SELECTOR);
    elements.forEach((element) => {
      const textContent = element.textContent?.trim();
      if (!textContent) {
        element.style.removeProperty("--hashtag-color");
        return;
      }

      const color = palette.get(textContent.toLowerCase());
      if (color) {
        element.style.setProperty("--hashtag-color", color);
      } else {
        element.style.removeProperty("--hashtag-color");
      }
    });
  }, [editor, palette]);

  useEffect(() => {
    applyColors();
  }, [applyColors]);

  useEffect(() => {
    return mergeRegister(
      editor.registerMutationListener(HashtagNode, () => {
        applyColors();
      }),
      editor.registerUpdateListener(() => {
        applyColors();
      }),
    );
  }, [editor, applyColors]);

  return null;
}

