import { describe, expect, it, beforeEach, afterEach, vi } from "bun:test";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

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

function StubChatPane() {
  return <div data-testid="chat-pane-stub" />;
}


afterEach(() => {
  cleanup();
});

beforeEach(() => {
  editorState.onChange = null;
  editorState.content = "";
});

describe("TimelineWorkspace", () => {
  it("loads snapshot and sends edits to backend", async () => {
    const invoke = vi.fn(
      async (command: string, _args?: Record<string, unknown>) => {
        if (command === "get_document_snapshot") {
          return { content: "Initial doc", version: 1 };
        }

        if (command === "handle_edit") {
          return { status: "ok", new_version: 2 } as const;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
    );

    render(<TimelineWorkspace invokeApi={invoke} EditorComponent={StubEditor} ChatPaneComponent={StubChatPane} />);

    await waitFor(() => {
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Initial doc");
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
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Initial doc!");
    });
  });

  it("reconciles conflicts by fetching the canonical document", async () => {
    const invoke = vi.fn(
      async (command: string, _args?: Record<string, unknown>) => {
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

    render(<TimelineWorkspace invokeApi={invoke} EditorComponent={StubEditor} ChatPaneComponent={StubChatPane} />);

    await waitFor(() => {
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Original");
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
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Canonical document");
    });
  });  it("opens and closes the collaborative session view", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "get_document_snapshot":
            return { content: "Initial doc", version: 1 };
          case "get_log_for_date":
            expect(args).toEqual({ date: today });
            return "Today log";
          default:
            throw new Error(`Unexpected command: ${command}`);
        }
      },
    );

    render(<TimelineWorkspace invokeApi={invoke} EditorComponent={StubEditor} ChatPaneComponent={StubChatPane} />);

    await waitFor(() => {
      expect(screen.getByTestId("timeline-main-view").textContent).toBe("Initial doc");
    });

    const reflectButton = screen.getByTestId("reflect-button");
    act(() => {
      fireEvent.click(reflectButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId("collaborative-session-view")).not.toBeNull();
    });

    await waitFor(() => {
      const sessionEditor = screen.getByTestId("mock-editor");
      expect(sessionEditor.textContent).toBe("Today log");
    });

    const closeButton = screen.getByTestId("close-session-button");
    act(() => {
      fireEvent.click(closeButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId("timeline-main-view").textContent).toBe("Initial doc");
    });
    expect(screen.queryByTestId("collaborative-session-view")).toBeNull();
  });


});
