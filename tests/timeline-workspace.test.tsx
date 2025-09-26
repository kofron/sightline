import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import TimelineWorkspace from "../src/components/TimelineWorkspace";

import type { TextOperation } from "../src/api/types";
import type { TimelineEditorProps } from "../src/editor/TimelineEditor";
import computeOperations from "../src/editor/operations";

type OnChange = (ops: TextOperation[], nextText: string) => void;

const editorState: { onChange: OnChange | null; content: string } = {
  onChange: null,
  content: "",
};

function handleCommonCommands(command: string, args?: Record<string, unknown>) {
  if (command === "list_tags") {
    return [];
  }

  if (command === "list_blocks") {
    const length = typeof editorState.content === "string" ? editorState.content.length : 0;
    return [
      {
        index: 0,
        start_offset: 0,
        end_offset: length,
        date: "2024-01-01",
        tags: [] as number[],
      },
    ];
  }

  if (command === "intern_tag") {
    const name = typeof args?.tag === "string" ? args.tag : "#tag";
    return { id: 1, name, color: "rgba(59, 130, 246, 0.3)" };
  }

  if (command === "assign_block_tags") {
    const tags = Array.isArray(args?.tags) ? (args?.tags as string[]) : [];
    return tags.map((name, index) => ({
      id: index + 1,
      name,
      color: "rgba(59, 130, 246, 0.3)",
    }));
  }

  return null;
}

function StubEditor({ document_content, on_change }: TimelineEditorProps) {
  editorState.onChange = on_change ?? null;
  editorState.content = document_content;
  return (
    <div data-testid="mock-editor" className="timeline-editor">
      <div className="timeline-editor__content">{document_content}</div>
    </div>
  );
}

function StubChatPane() {
  return <div data-testid="chat-pane-stub" />;
}

async function flushDebouncedEdits() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  editorState.onChange = null;
  editorState.content = "";
});

afterEach(() => {
  cleanup();
});

describe("TimelineWorkspace", () => {
  it("loads snapshot and sends edits to backend", async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        const common = handleCommonCommands(command, args);
        if (common !== null) {
          return common;
        }

        if (command === "get_document_snapshot") {
          return { content: "Initial doc", version: 1 };
        }

        if (command === "handle_edit") {
          return { status: "ok", new_version: 2 } as const;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
    );

    render(
      <TimelineWorkspace
        invokeApi={invoke}
        EditorComponent={StubEditor}
        ChatPaneComponent={StubChatPane}
      />,
    );

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

    await flushDebouncedEdits();

    await waitFor(() => {
      const call = invoke.mock.calls.find(([command]) => command === "handle_edit");
      expect(call).toBeDefined();
      if (!call) {
        return;
      }
      const [, args] = call;
      expect(args).toEqual({
        payload: {
          base_version: 1,
          ops: computeOperations("Initial doc", "Initial doc!"),
        },
      });
    });

    await waitFor(() => {
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Initial doc!");
    });
  });

  it("reconciles conflicts by fetching the canonical document", async () => {
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        const common = handleCommonCommands(command, args);
        if (common !== null) {
          return common;
        }

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

    render(
      <TimelineWorkspace
        invokeApi={invoke}
        EditorComponent={StubEditor}
        ChatPaneComponent={StubChatPane}
      />,
    );

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

    await flushDebouncedEdits();

    await waitFor(() => {
      expect(
        invoke.mock.calls.some(([command]) => command === "get_full_document"),
      ).toBe(true);
    });

    await waitFor(() => {
      const call = invoke.mock.calls.find(([command]) => command === "handle_edit");
      expect(call).toBeDefined();
      if (!call) {
        return;
      }
      const [, args] = call;
      expect(args).toEqual({
        payload: {
          base_version: 3,
          ops: computeOperations("Original", "Original update"),
        },
      });
    });

    await waitFor(() => {
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Canonical document");
    });
  });

  it("opens and closes the collaborative session view", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        const common = handleCommonCommands(command, args);
        if (common !== null) {
          return common;
        }

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

    render(
      <TimelineWorkspace
        invokeApi={invoke}
        EditorComponent={StubEditor}
        ChatPaneComponent={StubChatPane}
      />,
    );

    await waitFor(() => {
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Initial doc");
    });

    const reflectButton = screen.getByTestId("reflect-button");
    act(() => {
      fireEvent.click(reflectButton);
    });

    await waitFor(() => {
      expect(screen.getByTestId("collaborative-session-view")).not.toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-pane-stub")).toBeDefined();
    });

    const closeButton = screen.getByTestId("close-session-button");
    act(() => {
      fireEvent.click(closeButton);
    });

    await waitFor(() => {
      const editors = screen.getAllByTestId("mock-editor");
      expect(editors.at(-1)?.textContent).toBe("Initial doc");
    });
    expect(screen.queryByTestId("collaborative-session-view")).toBeNull();
  });

});
