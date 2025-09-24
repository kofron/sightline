import type { EditResponse, TextOperation } from "../api/types";

export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface TimelineSyncControllerOptions {
  invoke: InvokeFn;
  initialVersion?: number;
  onConflictResolved?: (document: string, version: number) => void;
  onEditApplied?: (version: number) => void;
}

export class TimelineSyncController {
  private readonly invoke: InvokeFn;

  private readonly onConflictResolved?: (document: string, version: number) => void;

  private readonly onEditApplied?: (version: number) => void;

  private version: number;

  private queue: Promise<void> = Promise.resolve();

  constructor(options: TimelineSyncControllerOptions) {
    const { invoke, initialVersion = 0, onConflictResolved, onEditApplied } = options;

    this.invoke = invoke;
    this.version = initialVersion;
    this.onConflictResolved = onConflictResolved;
    this.onEditApplied = onEditApplied;
  }

  getVersion(): number {
    return this.version;
  }

  handleEditorChange(operations: TextOperation[]): Promise<void> {
    if (operations.length === 0) {
      return Promise.resolve();
    }

    this.queue = this.queue.then(() => this.syncOperations(operations));
    return this.queue;
  }

  private async syncOperations(operations: TextOperation[]): Promise<void> {
    const payload = {
      base_version: this.version,
      ops: operations,
    };

    const response = await this.invoke<EditResponse>("handle_edit", { payload });

    if (response.status === "ok") {
      this.version = response.new_version;
      this.onEditApplied?.(response.new_version);
      return;
    }

    const document = await this.invoke<string>("get_full_document");
    this.version = response.server_version;
    this.onConflictResolved?.(document, response.server_version);
  }
}

export default TimelineSyncController;
