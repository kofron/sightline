export type TextOperation =
  | { type: "insert"; position: number; text: string }
  | { type: "delete"; start_position: number; end_position: number };

export interface EditPayload {
  base_version: number;
  ops: TextOperation[];
}

export type EditResponse =
  | { status: "ok"; new_version: number }
  | { status: "conflict"; server_version: number };

export interface DocumentSnapshot {
  content: string;
  version: number;
}
