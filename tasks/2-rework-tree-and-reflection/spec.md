## Engineering Plan: V1 Core Experience

This plan outlines the work to refactor the core data model to a flexible tagging system and implement the primary user-facing feature: the "Collaborative Session" for daily logs.

### Milestone 1: Data Model Refactor (Rust Backend)

**Ticket 1: Implement Tag Interning Registry**
* **Goal:** Create a system for managing a central registry of tags to ensure memory efficiency and enable global tag edits.
* **Details:** The `Timeline` struct will own a `HashMap<u32, String>` for the tag registry and a `HashMap<String, u32>` for fast lookups. A mechanism for adding new tags and getting or creating an ID for a tag string is required.
* **Acceptance Criteria:**
    * A `TagRegistry` struct is created with methods `get_id(&mut self, tag: &str) -> u32` and `get_tag(&self, id: u32) -> Option<&String>`.
    * A unit test proves that calling `get_id` with a new tag string returns a new, unique ID and adds the tag to the registry.
    * A unit test proves that calling `get_id` with an existing tag string returns its previously assigned ID.

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
    * The component test using **Vitest** verifies that when a user sends a message, the frontend **emits a Tauri event** (e.g., `event-name: 'chat-message'`, `payload: { text: '...' }`).
    * A **Rust event listener** is created in the backend that listens for the `'chat-message'` event.
    * A headless test for the Rust listener verifies that upon receiving a message, it **emits a new event back** to the frontend (e.g., `event-name: 'chat-response'`, `payload: { text: 'ECHO: ...' }`).
    * A component test verifies that the `ChatPane` correctly listens for the `'chat-response'` event and displays the echoed message in its history.
