import { describe, expect, it, beforeEach, vi } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";

import TimelineWorkspace from "../src/components/TimelineWorkspace";
import type { TextOperation } from "../src/api/types";
import type { TimelineEditorProps } from "../src/editor/TimelineEditor";

type OnChange = (ops: TextOperation[], nextText: string) => void;

const editorState: { onChange: OnChange | null; content: string } = {
  onChange: null,
  content: "",
};

function StubEditor({ document_content, on_change }: TimelineEditorProps) {
  editorState.onChange = on_change ?? null;
  editorState.content = document_content;
  return <div data-testid="mock-editor">{document_content}</div>;
}

beforeEach(() => {
  editorState.onChange = null;
  editorState.content = "";
});

describe("TimelineWorkspace", () => {
  it("loads snapshot and sends edits to backend", async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "get_document_snapshot") {
          return { content: "Initial doc", version: 1 };
        }

        if (command === "handle_edit") {
          return { status: "ok", new_version: 2 } as const;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
    );

    render(<TimelineWorkspace invokeApi={invoke} EditorComponent={StubEditor} />);

    await waitFor(() => {
      expect(screen.getByTestId("mock-editor").textContent).toBe("Initial doc");
    });

    expect(editorState.onChange).not.toBeNull();

    act(() => {
      editorState.onChange?.(
        [{ type: "insert", position: 10, text: "!" }],
        "Initial doc!",
      );
    });

    await waitFor(() => {
      expect(
        invoke.mock.calls.some(
          ([command, args]) =>
            command === "handle_edit" &&
            JSON.stringify(args) ===
              JSON.stringify({
                payload: {
                  base_version: 1,
                  ops: [{ type: "insert", position: 10, text: "!" }],
                },
              }),
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-editor").textContent).toBe(
        "Initial doc!",
      );
      expect(screen.getByText(/Version: 2/)).toBeTruthy();
    });
  });

  it("reconciles conflicts by fetching the canonical document", async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "get_document_snapshot":
            return { content: "Original", version: 3 };
          case "handle_edit":
            return { status: "conflict", server_version: 4 } as const;
          case "get_full_document":
            return "Canonical document";
          default:
            throw new Error(`Unexpected command: ${command}`);
        }
      },
    );

    render(<TimelineWorkspace invokeApi={invoke} EditorComponent={StubEditor} />);

    await waitFor(() => {
      expect(screen.getByTestId("mock-editor").textContent).toBe("Original");
    });

    act(() => {
      editorState.onChange?.(
        [{ type: "insert", position: 8, text: " update" }],
        "Original update",
      );
    });

    await waitFor(() => {
      expect(
        invoke.mock.calls.some(([command]) => command === "get_full_document"),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(
        invoke.mock.calls.some(
          ([command, args]) =>
            command === "handle_edit" &&
            JSON.stringify(args) ===
              JSON.stringify({
                payload: {
                  base_version: 3,
                  ops: [{ type: "insert", position: 8, text: " update" }],
                },
              }),
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-editor").textContent).toBe(
        "Canonical document",
      );
      expect(screen.getByText(/Version: 4/)).toBeTruthy();
      expect(screen.getByText("Document re-synced after conflict.")).toBeTruthy();
    });
  });
});
