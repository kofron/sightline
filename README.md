
# Sightline v0: Product & Technical Specification

## 1\. Project Overview & Philosophy

**Sightline** is a low-friction, text-first digital notebook designed for daily reflection, planning, and knowledge retrieval. The core philosophy is to provide an uncluttered, "out of the way" writing experience, with all intelligent features handled by a back-end LLM and accessed through discrete, user-initiated modes.

The v0 is a **single-device, local-first application** designed to prove the core user experience and de-risk the core technical architecture.

-----

## 2\. v0 Product Specification

### Core User Experience & Features

  * **The Timeline:** The entire user history is stored in a single, editable markdown document. This is the canonical source of truth.
  * **Daily Log View:** The primary interface is the view of the **Timeline** focused on the current day's content.
  * **Morning Check-in:** A guided, daily conversational workflow that helps the user reflect and generates a **Daily Plan**, which seeds that day's log.
  * **On-Demand Interaction:** A keyboard shortcut allows the user to ask natural language questions of the LLM at any time. The LLM analyzes the local **Timeline** document in real-time to provide answers.
  * **Navigation**:
      * **Exploratory Scrolling:** Users can infinitely scroll up from the current day to seamlessly navigate into their past logs.
      * **Direct Jump:** A keyboard shortcut allows users to jump directly to any date.

### Scope & Limitations for v0

  * **Local-Only:** v0 will not have user accounts, cloud sync, or multi-device support. The user's **Timeline** is stored as a single file on their local device.
  * **No External Integrations:** Features like calendar connection are deferred to a future version.

-----

## 3\. v0 Technical Specification

### High-Level Architecture

  * **Framework:** **Tauri**, utilizing a **Rust** backend for core logic and performance-critical tasks, and a **TypeScript** frontend for the user interface.
  * **Data Model:** The **Timeline** document is the single source of truth. There is no separate structured database; all analysis is performed on the raw text.

### Core Data Layer (Rust Backend)

  * **Data Structure:** The **Timeline** document will be managed in the Rust core using the provided **SumTree** CRDT implementation. This will handle all text manipulations, ensuring high performance on a potentially very large document.

### Frontend Editor (TypeScript Frontend)

  * **Framework:** The editor interface will be built using the **Lexical** framework.
  * **Architectural Pattern:** The Lexical editor will be implemented as a "thin view." It will not maintain a complete, independent state of the document. Instead, it will render the state provided by the Rust core and emit user actions as events.

### Communication Bridge (Lexical ↔ Rust)

  * **Model:** An **optimistic concurrency** model will be used to ensure a snappy UI. The Lexical UI updates its local view instantly and sends edits to the Rust backend for validation.
  * **Events (UI → Rust):** User edits are sent from the frontend as a batch of operations against a specific document version.
    ```typescript
    interface EditPayload {
      base_version: number;
      ops: TextOperation[];
    }

    type TextOperation =
      | { type: 'insert'; position: number; text: string; }
      | { type: 'delete'; start_position: number; end_position: number; };
    ```
  * **Responses (Rust → UI):** The backend validates the `base_version` and responds with either success or a conflict.
    ```typescript
    type EditResponse =
      | { status: 'ok'; new_version: number; }
      | { status: 'conflict'; server_version: number; };
    ```
  * **Conflict Reconciliation:** On receiving a `conflict` status, the UI will re-fetch the entire document from the Rust core and intelligently restore the user's cursor and scroll position.

## Sightline v0: Final Engineering Ticketsx

Overall notes:

- We are using bun for the typescript side of things.
- Always use tooling for installing packages e.g. bun add / cargo add.
- Always validate your work by using `cargo xtask all`

### Milestone 1: Core Backend & Project Setup

**Ticket 1: Project Initialization**
* **Goal:** Set up the basic Tauri project structure with Rust and TypeScript.
* **Acceptance Criteria:**
    * `cargo check` in the Rust directory passes without errors.
    * `tsc --noEmit` in the frontend directory passes without errors.
    * The `SumTree` Rust module is part of the Rust crate and is successfully compiled.
    * The `lexical` package is listed as a dependency in `package.json`.

---
**Ticket 2: Implement the `Timeline` Data Model (Rust)**
* **Goal:** Create the core Rust structs and logic that manage the in-memory `SumTree` document state.
* **Acceptance Criteria:**
    * The `LogEntry` (`Item`) and `TimelineSummary` (`Summary`) structs are implemented in Rust as specified, using `chrono::NaiveDate`.
    * The `Item` and `Summary` traits are implemented for these structs, respectively.
    * A unit test verifies the `TimelineSummary::add_summary` method correctly aggregates byte counts, character counts, and `min`/`max` date ranges.
    * The `Timeline` struct is created, holding a `SumTree<LogEntry>`.
    * A unit test demonstrates that calling an `apply_ops` method on the `Timeline` with an `Insert` operation correctly updates its content and version number.

---
**Ticket 2.5: Implement Local File Persistence (Rust)**
* **Goal:** Save the `Timeline` document to the standard OS config directory on changes and load it on startup.
* **Acceptance Criteria:**
    * The `dirs` crate is added as a dependency in `Cargo.toml`.
    * A headless function `get_storage_path()` is created that returns the platform-specific path for `sightline/timeline.json` using `dirs::config_dir()`.
    * The `Timeline` struct has a `save()` method that serializes its content and writes it to a file. This is verified in a unit test using a mock file path.
    * A `Timeline::load()` function is created that can deserialize a file and instantiate the struct. This is verified in a unit test.

---
### Milestone 2: The Communication Bridge

**Ticket 3: Define the API Contract (Rust & TS)**
* **Goal:** Implement the shared data structures for the communication bridge.
* **Acceptance Criteria:**
    * The Rust `EditPayload`, `TextOperation`, and `EditResponse` structs derive `serde::Serialize` and `serde::Deserialize`.
    * A Rust unit test successfully serializes an `EditResponse` struct to a JSON string.
    * The corresponding TypeScript types are defined, and the JSON string from the Rust test can be successfully parsed into a matching TypeScript object.

---
**Ticket 4: Expose Backend Commands (Rust)**
* **Goal:** Create and test the Tauri commands that expose `Timeline` functionality.
* **Acceptance Criteria:**
    * A Rust integration test can invoke the `handle_edit` command with a valid `EditPayload` and assert that the returned `EditResponse` has a status of `'ok'`.
    * An integration test can invoke `handle_edit` with a mismatched `base_version` and assert that the returned `EditResponse` has a status of `'conflict'`.
    * An integration test can invoke `get_full_document` and assert that the returned string is correct.

---
### Milestone 3: Frontend Editor Implementation

**Ticket 5: Headless Lexical Editor View**
* **Goal:** Create a testable Lexical component that renders state provided to it.
* **Acceptance Criteria:**
    * A component test using **Vitest** can mount the Lexical editor component.
    * The component accepts a `document_content` prop. A test asserts that when this prop is set, the editor's internal state reflects the provided string.
    * The component emits an `on_change` event with a `TextOperation[]` payload. A test can simulate user input and assert that the correct event is emitted.

---
**Ticket 6: Wire Up Optimistic Concurrency Logic**
* **Goal:** Implement the client-side logic for sending edits and handling responses.
* **Acceptance Criteria:**
    * A unit test for a client-side "sync controller" can be written.
    * The test demonstrates that when the controller receives an `on_change` event from the editor, it calls the mock Tauri `invoke('handle_edit', ...)` function with the correct `EditPayload`.
    * The test demonstrates that when the mock `handle_edit` function returns an `'ok'` response, the controller updates its internal version number.
    * The test demonstrates that when the mock `handle_edit` function returns a `'conflict'` response, the controller calls the mock `invoke('get_full_document')`.

---
### Milestone 4: Core Product Features

**Ticket 7: Headless On-Demand Interaction Logic**
* **Goal:** Isolate and test the logic for the on-demand LLM query.
* **Acceptance Criteria:**
    * A headless function `prepare_llm_prompt(query: string, document: string)` is created.
    * A unit test asserts that this function correctly formats the inputs into the specific prompt structure required by the LLM.
    * A headless function `process_llm_response(response: string)` is created. A unit test asserts that it correctly extracts the desired text from the LLM's raw output.

---
**Ticket 8: Headless Morning Check-in Logic**
* **Goal:** Implement the state management for a manually-triggered guided daily reflection.
* **Acceptance Criteria:**
    * A **simple TypeScript class** is implemented to manage the state machine of the check-in flow.
    * Unit tests verify all valid state transitions (e.g., from `AwaitingReflection` to `AwaitingDialogue`).
    * A unit test for the `AwaitingDialogue` state asserts that it correctly calls the `prepare_llm_prompt` function with the user's reflection.
    * A **debug button or command** is added to the application that manually triggers the start of the Morning Check-in flow for testing purposes.

---
**Ticket 9: Headless Navigation Logic**
* **Goal:** Create and test the backend logic for retrieving historical data.
* **Acceptance Criteria:**
    * A new Tauri command, `get_log_for_date(date: string) -> String`, is created in Rust.
    * The `Timeline` struct has a method for efficiently finding and returning the text content associated with a specific date by querying the `TimelineSummary`.
    * An integration test calls `get_log_for_date` with a mock `Timeline` and asserts that the correct substring is returned.
