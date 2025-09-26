import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  type TextNode,
  type LexicalCommand,
  type NodeKey,
  type LexicalNode,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

import type { InvokeFn } from "../../sync/TimelineSyncController";
import { useTagStore, type TagDescriptor } from "@/lib/tag-store";
import { BlockMetadata, useBlockStore } from "@/lib/block-store";

const TAG_CREATION_COLOR = "rgba(59, 130, 246, 0.2)";

interface ActiveTagSelection {
  nodeKey: NodeKey;
  startOffset: number;
  endOffset: number;
  absoluteStart: number;
  absoluteEnd: number;
  query: string;
}

interface TagPluginProps {
  invokeApi: InvokeFn;
  refreshBlocks: () => void;
}

export type TagSuggestion = {
  descriptor: TagDescriptor;
  isNew: boolean;
};

export function buildTagSuggestions(
  query: string | null,
  tags: Map<number, TagDescriptor>,
): TagSuggestion[] {
  if (query == null) {
    return [];
  }

  const normalized = query.toLowerCase();
  const existing = Array.from(tags.values())
    .filter((item) => item.name.toLowerCase().includes(normalized))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((descriptor) => ({ descriptor, isNew: false }));

  const alreadyExists = existing.some(
    (item) => item.descriptor.name.toLowerCase() === `#${normalized}`,
  );

  if (normalized.length > 0 && !alreadyExists) {
    existing.unshift({
      descriptor: {
        id: -1,
        name: `#${normalized}`,
        color: TAG_CREATION_COLOR,
      },
      isNew: true,
    });
  }

  return existing;
}

export function TagPlugin({ invokeApi, refreshBlocks }: TagPluginProps) {
  const [editor] = useLexicalComposerContext();
  const { tags, upsert: upsertTags } = useTagStore();
  const { blocks } = useBlockStore();

  const [activeSelection, setActiveSelection] =
    useState<ActiveTagSelection | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);

  const suggestions = useMemo<TagSuggestion[]>(() => {
    return buildTagSuggestions(activeSelection?.query ?? null, tags);
  }, [activeSelection, tags]);

  const updateMenuRect = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setMenuRect(rect);
    }
  }, []);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setActiveSelection(null);
          return;
        }

        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          setActiveSelection(null);
          return;
        }

        const textContent = node.getTextContent();
        const offset = anchor.offset;
        const tagInfo = extractTagContext(node, textContent, offset);
        if (!tagInfo) {
          setActiveSelection(null);
          return;
        }

        const absolute = computeAbsoluteOffset(node, tagInfo.startOffset);
        const selectionInfo: ActiveTagSelection = {
          nodeKey: node.getKey(),
          startOffset: tagInfo.startOffset,
          endOffset: tagInfo.endOffset,
          absoluteStart: absolute,
          absoluteEnd: absolute + (tagInfo.endOffset - tagInfo.startOffset),
          query: tagInfo.query,
        };
        setActiveSelection(selectionInfo);
        setSelectedIndex(0);
        updateMenuRect();
      });
    });
  }, [editor, updateMenuRect]);

  const confirmTag = useCallback(
    async (item: TagSuggestion): Promise<void> => {
      if (!activeSelection) {
        return;
      }

      const block = findBlockForOffset(activeSelection.absoluteStart, blocks);
      if (!block) {
        setActiveSelection(null);
        return;
      }

      let descriptor = item.descriptor;
      if (item.isNew) {
        descriptor = await invokeApi<TagDescriptor>("intern_tag", {
          tag: descriptor.name,
        });
        upsertTags([descriptor]);
      }

      const nextTagIds = new Set<number>(block.tags ?? []);
      if (descriptor.id !== -1) {
        nextTagIds.add(descriptor.id);
      }

      const tagNames = Array.from(nextTagIds)
        .map((id) => tags.get(id)?.name ?? descriptor.name)
        .filter((name) => name.length > 0);

      if (!tagNames.includes(descriptor.name)) {
        tagNames.push(descriptor.name);
      }

      const assigned = await invokeApi<TagDescriptor[]>("assign_block_tags", {
        blockIndex: block.index,
        tags: tagNames,
      });

      upsertTags(assigned);
      refreshBlocks();

      editor.update(() => {
        const node = $getNodeByKey(activeSelection.nodeKey);
        if (!$isTextNode(node)) {
          return;
        }

        let target: TextNode = node;
        const { startOffset, endOffset } = activeSelection;
        const size = target.getTextContentSize();

        if (endOffset < size) {
          target = target.splitText(endOffset)[0];
        }
        if (startOffset > 0) {
          target = target.splitText(startOffset)[1];
        }

        target.setTextContent(descriptor.name);
        const nextPosition = target.getTextContentSize();
        target.select(nextPosition, nextPosition);
      });

      setActiveSelection(null);
    },
    [
      activeSelection,
      blocks,
      editor,
      invokeApi,
      refreshBlocks,
      tags,
      upsertTags,
    ],
  );

  // Register keyboard handling while a tag is active
  useEffect(() => {
    if (!activeSelection) {
      return;
    }

    return editor.registerCommand(
      KEY_DOWN_COMMAND as LexicalCommand<KeyboardEvent>,
      (event) => {
        if (!activeSelection || suggestions.length === 0) {
          return false;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((value) => (value + 1) % suggestions.length);
          return true;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex(
            (value) => (value - 1 + suggestions.length) % suggestions.length,
          );
          return true;
        }

        if (event.key === "Tab" || event.key === "Enter") {
          event.preventDefault();
          const chosen = suggestions[selectedIndex] ?? suggestions[0];
          if (chosen) {
            void confirmTag(chosen);
          }
          return true;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          setActiveSelection(null);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, activeSelection, suggestions, selectedIndex, confirmTag]);

  const portal =
    activeSelection && menuRect && suggestions.length > 0
      ? createPortal(
          <AutocompletePopover
            rect={menuRect}
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            onSelect={(index) => {
              setSelectedIndex(index);
              void confirmTag(suggestions[index]);
            }}
          />,
          document.body,
        )
      : null;

  return portal;
}

function extractTagContext(
  node: TextNode,
  text: string,
  cursorOffset: number,
) {
  if (cursorOffset === 0) {
    return null;
  }

  let start = cursorOffset - 1;
  while (start >= 0) {
    const char = text[start];
    if (char === "#") {
      break;
    }
    if (char === " " || char === "\n" || char === "\t") {
      return null;
    }
    start--;
  }

  if (start < 0 || text[start] !== "#") {
    return null;
  }

  const parent = node.getParent();
  if (parent == null) {
    return null;
  }

  const startWithinParent = computeOffset(node, start, parent);
  const parentText = parent.getTextContent();
  const lineStart = parentText.lastIndexOf("\n", startWithinParent - 1) + 1;
  const linePrefix = parentText.substring(lineStart, startWithinParent);
  const hasNonHeadingContent = linePrefix.replace(/#/g, "").trim().length > 0;
  if (!hasNonHeadingContent) {
    return null;
  }

  const query = text.substring(start + 1, cursorOffset);
  return {
    startOffset: start,
    endOffset: cursorOffset,
    query,
  };
}

function computeAbsoluteOffset(node: TextNode, relativeOffset: number): number {
  return computeOffset(node, relativeOffset);
}

function findBlockForOffset(
  offset: number,
  blocks: BlockMetadata[],
): BlockMetadata | null {
  for (const block of blocks) {
    if (offset >= block.startOffset && offset <= block.endOffset) {
      return block;
    }
  }
  if (blocks.length > 0) {
    return blocks[blocks.length - 1];
  }
  return null;
}

function AutocompletePopover({
  rect,
  suggestions,
  selectedIndex,
  onSelect,
}: {
  rect: DOMRect;
  suggestions: TagSuggestion[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const style: React.CSSProperties = {
    top: rect.bottom + 8,
    left: rect.left,
  };

  return (
    <div className="tag-autocomplete-popover" style={style}>
      <ul>
        {suggestions.map((item, index) => (
          <li
            key={`${item.descriptor.name}-${index}`}
            className="tag-autocomplete-item"
            data-selected={index === selectedIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(index);
            }}
          >
            <span
              className="tag-color-swatch"
              style={{ backgroundColor: item.descriptor.color }}
            />
            <span>{item.descriptor.name}</span>
            {item.isNew && (
              <span style={{ color: "rgba(59, 130, 246, 0.8)" }}>Create</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default TagPlugin;
export { extractTagContext };

function computeOffset(
  node: LexicalNode,
  relativeOffset: number,
  boundary?: LexicalNode | null,
): number {
  let total = relativeOffset;
  let current: LexicalNode = node;

  while (true) {
    const parent = current.getParent();
    if (parent == null) {
      break;
    }

    const siblings = parent.getChildren();
    for (const sibling of siblings) {
      if (sibling === current) {
        break;
      }
      total += sibling.getTextContentSize();
    }

    if (parent === boundary) {
      break;
    }

    current = parent;
  }

  return total;
}
