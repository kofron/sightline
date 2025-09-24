import { describe, expect, it, vi } from "bun:test";
import {
  act,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { $createTextNode, $getRoot, type LexicalEditor } from "lexical";

import TimelineEditor from "../src/editor/TimelineEditor";
import type { TextOperation } from "../src/api/types";
import { $createParagraphNode } from "lexical";

describe("TimelineEditor", () => {
  it("renders provided document_content", async () => {
    render(<TimelineEditor document_content="Hello world" />);

    await waitFor(() => {
      expect(screen.getByTestId("timeline-editor-content").textContent).toBe(
        "Hello world",
      );
    });
  });

  it("emits on_change operations when content updates", async () => {
    const onChange = vi.fn();
    let editor: LexicalEditor | null = null;

    render(
      <TimelineEditor
        document_content=""
        on_change={onChange}
        register_editor={(instance) => {
          editor = instance;
        }}
      />,
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
});
