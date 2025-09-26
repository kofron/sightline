## Engineering Plan: V1 Core Experience

This plan outlines the work to refactor the core data model to a flexible tagging system and implement the primary user-facing feature: the "Collaborative Session" for daily logs.

## Engineering Q&A Clarifications

* **TaggedBlock structure**: Each block keeps `date: NaiveDate`, `text: String`, and `tags: Vec<u32>`. Dates stay first-class metadata.
* **TimelineSummary dates**: Continue tracking `min_date`/`max_date`; Bloom filters augment tag lookups only.
* **Snapshot format**: Persist as `{ version, blocks: [TaggedBlock], tag_registry: [Tag] }` where `Tag { id, name, parent_id, color? }`; continue accepting the legacy `{ id -> "path" }` map when loading.
* **Importer CLI**: Workspace now owns a standalone `importer` binary crate that reuses the shared registry helpers; `--source` and `--output` are required, the tool walks `/journal` and `/projects`, applies `#type:journal` / `#type:project-note` tags, builds hierarchical `project:*` tags from directory paths, and emits the new `{ blocks, tag_registry }` snapshot format.
* **Tag autocomplete**: Backend `autocomplete_tag` now returns structured suggestions of `{ name, color? }`, enabling the UI to surface palette metadata alongside tag names.
* **Today editor**: Reuse existing `TimelineEditor`; parent fetches today’s content via `get_log_for_date`.
* **Chat events**: Use `chat-message`/`chat-response` names; backend echo listener satisfies PoC.
* **Initial prompt copy**: Return a short, user-facing string (e.g., friendly greeting) rather than LLM payload.
* **Frontend chat test seam**: The `ChatPane` component should accept injectable `emit`/`listen` handlers so tests can stub the Tauri event bridge without real IPC.

### Milestone 1: Data Model Refactor (Rust Backend)

**Ticket 1: Implement Tag Interning Registry**
* **Goal:** Create a system for managing a central registry of tags to ensure memory efficiency and enable global tag edits.
* **Details:** The `Timeline` struct will own a normalized `TagRegistry` that stores `Tag { id, name, parent_id }` entries, plus lookups for `(parent_id, name) -> id`. Helpers should exist for interning colon-delimited paths and reconstructing display names from stored segments.
* **Acceptance Criteria:**
    * A `TagRegistry` struct exposes `intern_segment`, `intern_path`, and `full_name` APIs, along with `intern_colon_path` for convenience.
    * Unit tests prove that inserting a new segment creates a unique ID, reusing the ID for repeated paths and preserving parent/child links.
    * Unit tests prove that `full_name` yields colon-delimited display strings in the correct hierarchy order.

---
**Ticket 2: Refactor `LogEntry` to `TaggedBlock`**
* **Goal:** Replace the `LogEntry` `Item` in the `SumTree` with a new, more flexible `TaggedBlock` that uses interned tag IDs.
* **Acceptance Criteria:**
    * The `LogEntry` struct is replaced with a `TaggedBlock` struct containing `text: String` and `tags: Vec<u32>`.
    * All parts of the `Timeline` implementation that previously referenced `LogEntry` are updated to use `TaggedBlock`.
    * The `TimelineSnapshot` struct is updated to serialize both the `Vec<TaggedBlock>` and the `TagRegistry` `HashMap`.
    * Existing unit tests for saving and loading a `Timeline` are updated and pass.

---
**Ticket 3: Integrate Bloom Filter into `TimelineSummary`**
* **Goal:** Enhance the `TimelineSummary` to include a Bloom filter for fast, probabilistic tag queries.
* **Acceptance Criteria:**
    * The `bloomfilter` crate is added as a dependency.
    * The `TimelineSummary` struct is updated to include a `tags_filter: Bloom<u32>` field.
    * The `Item` trait implementation for `TaggedBlock` is updated: its `summary()` method must now insert all of its `tag_ids` into the summary's `tags_filter`.
    * The `Summary` trait implementation for `TimelineSummary` is updated: its `add_summary()` method must perform a bitwise `OR` (union) on the two `tags_filter` fields.
    * A unit test proves that a `FilterCursor` using a tag query correctly prunes tree branches that do not contain a specific tag ID.

### Milestone 2: Collaborative Session (Frontend & Backend)

**Ticket 4: Implement "Collaborative Session" View**
* **Goal:** Create the main UI container that switches between the default single-pane editor and the two-pane collaborative session.
* **Acceptance Criteria:**
    * A "Reflect" button is implemented in the primary UI.
    * A component test using **Vitest** verifies that, by default, only the main `TimelineEditor` is visible.
    * The component test verifies that clicking "Reflect" renders a new view containing both an editor pane (`TodayEditor`) and a chat pane (`ChatPane`), and the main editor is hidden.
    * The component test verifies that a "Close" button in the session view hides the session view and reveals the main `TimelineEditor` again.

**Ticket 5 : Implement the Stubbed Chat Pane via Tauri Channels**
* **Goal:** Build the right-hand chat pane using Tauri's event system (Channels) to allow for asynchronous, streaming communication. For the PoC, the backend will be a simple echo listener.
* **Acceptance Criteria:**
    * The `ChatPane` component contains a text input, a "Send" button, and a message history area.
    * A headless function `get_initial_prompt(is_daily_log_empty: bool)` is created and unit tested.
    * The chat pane exposes a thin seam for dependency injection so tests can provide mock `emit` / `listen` functions without using the real Tauri runtime.
    * The component test using **Vitest** verifies that when a user sends a message, the frontend **emits a Tauri event** (e.g., `event-name: 'chat-message'`, `payload: { text: '...' }`).
    * A **Rust event listener** is created in the backend that listens for the `'chat-message'` event.
    * A headless test for the Rust listener verifies that upon receiving a message, it **emits a new event back** to the frontend (e.g., `event-name: 'chat-response'`, `payload: { text: 'ECHO: ...' }`).
    * A component test verifies that the `ChatPane` correctly listens for the `'chat-response'` event and displays the echoed message in its history.
