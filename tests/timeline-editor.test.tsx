import { describe, expect, it, vi } from "bun:test";
import {
  act,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
} from "lexical";
import { $isHeadingNode } from "@lexical/rich-text";
import { $isListNode } from "@lexical/list";

import TimelineEditor from "../src/editor/TimelineEditor";
import type { TextOperation } from "../src/api/types";
// import computeOperations from "../src/editor/operations";
import { TagStoreProvider } from "../src/lib/tag-store";
import { BlockStoreProvider } from "../src/lib/block-store";

function withProviders(component: ReactElement): ReactElement {
  return (
    <TagStoreProvider>
      <BlockStoreProvider>{component}</BlockStoreProvider>
    </TagStoreProvider>
  );
}

describe("TimelineEditor", () => {
  it("renders provided document_content", async () => {
    render(withProviders(<TimelineEditor document_content="Hello world" />));

    await waitFor(() => {
      expect(screen.getByTestId("timeline-editor-content").textContent).toBe(
        "Hello world",
      );
    });
  });

  it("parses markdown headings into lexical nodes", async () => {
    let editor: LexicalEditor | null = null;

    render(
      withProviders(
        <TimelineEditor
          document_content="# Today"
          register_editor={(instance) => {
            editor = instance;
          }}
        />,
      ),
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    const instance = editor;
    if (!instance) {
      throw new Error("editor failed to initialize");
    }

    await waitFor(() => {
      const isHeading = instance.getEditorState().read(() => {
        const root = $getRoot();
        const firstChild = root.getFirstChild();
        return firstChild !== null && $isHeadingNode(firstChild);
      });
      expect(isHeading).toBe(true);
    });
  });

  it("emits on_change operations when content updates", async () => {
    const onChange = vi.fn();
    let editor: LexicalEditor | null = null;

    render(
      withProviders(
        <TimelineEditor
          document_content=""
          on_change={onChange}
          register_editor={(instance) => {
            editor = instance;
          }}
        />,
      ),
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    const instance = editor;
    if (!instance) {
      throw new Error("editor failed to initialize");
    }

    await act(() => {
      instance.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Hello"));
        root.append(paragraph);
      });
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const lastCall = onChange.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    const [ops, nextText] = lastCall as [TextOperation[], string];

    expect(ops).toEqual([
      {
        type: "insert",
        position: 0,
        text: "Hello",
      },
    ]);
    expect(nextText).toBe("Hello");
  });

  it("serializes bold formatting back to markdown", async () => {
    const onChange = vi.fn();
    let editor: LexicalEditor | null = null;

    render(
      withProviders(
        <TimelineEditor
          document_content="Hello world"
          on_change={onChange}
          register_editor={(instance) => {
            editor = instance;
          }}
        />,
      ),
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    const instance = editor;
    if (!instance) {
      throw new Error("editor failed to initialize");
    }

    await act(() => {
      instance.update(() => {
        const root = $getRoot();
        root.clear();

        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Hello "));

        const boldNode = $createTextNode("world");
        boldNode.toggleFormat("bold");
        paragraph.append(boldNode);

        root.append(paragraph);
      });
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const lastCall = onChange.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    const [ops, nextText] = lastCall as [TextOperation[], string];

    expect(nextText).toBe("Hello **world**");
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

  it("exits a list item after two paragraphs", async () => {
    const onChange = vi.fn();
    let editor: LexicalEditor | null = null;

    render(
      withProviders(
        <TimelineEditor
          document_content="- item"
          on_change={onChange}
          register_editor={(instance) => {
            editor = instance;
          }}
        />,
      ),
    );

    await waitFor(() => {
      expect(editor).not.toBeNull();
    });

    const instance = editor;
    if (!instance) {
      throw new Error("editor failed to initialize");
    }

    await act(() => {
      instance.update(() => {
        const root = $getRoot();
        const list = root.getFirstChild();
        if (list && $isListNode(list)) {
          const item = list.getLastChild();
          item?.selectEnd();
        }
      });
    });

    await act(async () => {
      instance.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });

    await act(async () => {
      instance.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const exitedList = instance.getEditorState().read(() => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      return lastChild !== null && lastChild.getType() === "paragraph";
    });
    expect(exitedList).toBe(true);

    const lastCall = onChange.mock.calls.at(-1);
    expect(lastCall).not.toBeUndefined();
    const [ops, nextText] = lastCall as [TextOperation[], string];

    expect(nextText).toBe("- item\n");
    expect(ops.length).toBeGreaterThan(0);
  });
});
