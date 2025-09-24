import { describe, expect, it, vi } from "bun:test";

import type { TextOperation } from "../src/api/types";
import TimelineSyncController from "../src/sync/TimelineSyncController";

const sampleOps: TextOperation[] = [
  { type: "insert", position: 0, text: "Hello" },
];

describe("TimelineSyncController", () => {
  it("invokes handle_edit with base version and operations", async () => {
    const invoke = vi.fn().mockImplementation(async (command: string) => {
      if (command === "handle_edit") {
        return { status: "ok", new_version: 1 } as const;
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const controller = new TimelineSyncController({
      invoke,
      initialVersion: 0,
    });

    await controller.handleEditorChange(sampleOps);

    expect(invoke).toHaveBeenCalledWith("handle_edit", {
      payload: { base_version: 0, ops: sampleOps },
    });
  });

  it("updates version on successful edit", async () => {
    const invoke = vi.fn().mockImplementation(async (command: string) => {
      if (command === "handle_edit") {
        return { status: "ok", new_version: 2 } as const;
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const controller = new TimelineSyncController({ invoke, initialVersion: 1 });

    await controller.handleEditorChange(sampleOps);

    expect(controller.getVersion()).toBe(2);
  });

  it("fetches full document on conflict and updates version", async () => {
    const onConflictResolved = vi.fn();

    const invoke = vi.fn().mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "handle_edit") {
          expect(args).toEqual({
            payload: {
              base_version: 3,
              ops: sampleOps,
            },
          });
          return { status: "conflict", server_version: 5 } as const;
        }

        if (command === "get_full_document") {
          return "SERVER_DOCUMENT";
        }

        throw new Error(`unexpected command: ${command}`);
      },
    );

    const controller = new TimelineSyncController({
      invoke,
      initialVersion: 3,
      onConflictResolved,
    });

    await controller.handleEditorChange(sampleOps);

    expect(invoke).toHaveBeenCalledWith("get_full_document");
    expect(controller.getVersion()).toBe(5);
    expect(onConflictResolved).toHaveBeenCalledWith("SERVER_DOCUMENT", 5);
  });
});
