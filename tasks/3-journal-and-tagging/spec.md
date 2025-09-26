
## Product Requirements Document: Sightline V1

### 1. Vision & Mission
**Vision:** To create a low-friction, intelligent notebook that acts as a second brain for personal reflection, planning, and knowledge synthesis.

**Mission:** Sightline helps users capture the unstructured thoughts of their daily lives and effortlessly discover the connections and insights within them. It is a collaborative partner in the process of thinking, not just a place to store text.

### 2. User Persona: The Reflective Professional
* **Who:** A busy professional, creator, or student who values self-reflection and personal organization but is frustrated by the high friction and rigid structure of existing note-taking and journaling apps.
* **Needs:** A quick, seamless way to jot down thoughts, plans, and ideas. A tool that helps them connect disparate pieces of information and see the bigger picture of their life and work without demanding constant, tedious organization.

### 3. Problems to Be Solved
* Journaling is a high-friction activity; opening an app, finding the right page, and staring at a blank screen is a deterrent.
* Traditional notes are "data-cemeteries"; information goes in but is rarely rediscovered or connected to other ideas.
* Life is not a perfectly structured outline. Notes about projects, fleeting ideas, and daily events are often intertwined, and tools should reflect this messy reality.

### 4. User Stories & Features

#### Epic: The Core Writing Experience
* **As a user, I want** a single, seamless timeline for all my entries **so that** I can scroll through my history without friction.
* **As a user, I want** to write in plain text with markdown support **so that** the writing experience is simple and powerful.
* **As a user, I want** to be able to edit any past entry **so that** my timeline is a living document.

#### Epic: The Collaborative Session
* **As a user, I want** to be able to enter a "reflection mode" for the current day at any time **so that** I can process my thoughts with an AI partner.
* **As a user, when my day is new, I want** the AI to prompt me to start a daily plan **so that** I can begin my day with intention.
* **As a user, when my day has entries, I want** the AI to use my existing text as context **so that** our conversation is relevant to my day's events.

#### Epic: The Knowledge Graph (Tagging)
* **As a user, I want** to add tags to any block of text **so that** I can create flexible, personal organizational systems.
* **As a user, I want** to create hierarchical tags (e.g., `#project:sightline`) **so that** I can structure my knowledge.
* **As a user, I want** to search for all notes under a parent tag (e.g., find all `#project` notes) **so that** I can easily review all my work in a specific area.

### 5. Non-Goals for V1
* **No Real-time Collaboration:** Sightline is a single-user application.
* **No Rich Media:** This version will not support images, videos, or file attachments. It is a text-first experience.
* **No Complex UI:** The interface will remain minimal. We are explicitly not building a feature-rich word processor or a complex dashboard.

## Sightline V1: Consolidated Engineering Plan

### Clarifications (Journal & Tagging Scope)

- The `TagRegistry` stores normalized `Tag` records where `name` is a single path segment (e.g., `"sightline"`) and hierarchy is expressed via `parent_id`.
- Full display names using colons (e.g., `#project:sightline`) are reconstructed on demand by traversing parents and joining the stored segments.
- The importer will live in its own workspace binary crate (`importer`), separate from `xtask`.
- Project notes parsed from `/projects` should receive both the path-derived tags and an automatic `#type:project-note` tag alongside existing rules like `#type:journal`.
- Runtime helpers (`intern_path`, `intern_colon_path`, `full_name`) are available on the `TagRegistry` to simplify building and displaying hierarchical tags.
- Search commands strip any leading `#`, compare case-insensitively against canonical tag names, and return timeline block indices in ascending order; autocomplete results are formatted with the leading `#`.

### Milestone 1: Data Model Refactor (Rust Backend)

**Ticket 1: Implement the `TagRegistry`**
* **Goal:** Create the core Rust struct for managing the explicit tag hierarchy.
* **Details:** The `TagRegistry` will manage `Tag` structs (`{ id: u32, name: String, parent_id: Option<u32> }`). It needs methods for adding new tags, finding tags by name, and building the parent-child relationships.
* **Acceptance Criteria:** A unit test proves that a path like `/a/b/c` correctly creates three tags in the registry, with `b` being a child of `a`, and `c` being a child of `b`.

---
**Ticket 2: Refactor `LogEntry` to `TaggedBlock`**
* **Goal:** Replace the `LogEntry` `Item` in the `SumTree` with a new, more flexible `TaggedBlock` that uses interned tag IDs.
* **Acceptance Criteria:**
    * The `LogEntry` struct is replaced with a `TaggedBlock` struct containing `date: NaiveDate`, `text: String`, and `tags: Vec<u32>`.
    * The `TimelineSnapshot` struct is updated to serialize both the `Vec<TaggedBlock>` and the `TagRegistry`.
    * Existing unit tests for saving and loading a `Timeline` are updated and pass.

---
**Ticket 3: Integrate Bloom Filter into `TimelineSummary`**
* **Goal:** Enhance the `TimelineSummary` to include a Bloom filter for fast, probabilistic tag queries.
* **Acceptance Criteria:**
    * The `bloomfilter` crate is added as a dependency.
    * The `TimelineSummary` struct is updated to include a `tags_filter: Bloom<u32>` field, while retaining the `min_date` and `max_date` fields.
    * The `Item` trait implementation for `TaggedBlock` is updated to insert all of its `tag_ids` into the summary's `tags_filter`.
    * The `Summary` trait implementation for `TimelineSummary` is updated to perform a bitwise `OR` (union) on the `tags_filter` fields.

### Milestone 2: Data Importer (Rust CLI)

**Ticket 4: Implement the Importer CLI**
* **Goal:** Create a simple command-line interface for the Rust importer program.
* **Acceptance Criteria:** The program accepts two arguments: the path to the source directory (e.g., Obsidian vault) and the path for the output `timeline.json` file.

---
**Ticket 5: Implement Journal Parsing**
* **Goal:** Implement the logic to parse the `/journal` directory.
* **Acceptance Criteria:**
    * The importer correctly iterates through all `.md` files in the `/journal` directory.
    * It successfully parses the date from filenames like "Sept 14, 2025.md".
    * It creates a `TaggedBlock` for each file with the correct date, text content, and the `#type:journal` tag.

---
**Ticket 6: Implement Project Note Parsing**
* **Goal:** Implement the logic to parse the `/projects` directory and build the tag hierarchy.
* **Acceptance Criteria:**
    * The importer recursively iterates through all `.md` files in the `/projects` directory.
    * For each file, it correctly generates the hierarchical tags in the `TagRegistry` based on the file's path.
    * It creates a `TaggedBlock` for each file with the file's modification date, text content, and the correct set of tag IDs.

### Milestone 3: Collaborative Session UX (Frontend)

**Ticket 7: Implement "Collaborative Session" View**
* **Goal:** Create the main UI container that switches between the default single-pane editor and the two-pane collaborative session.
* **Acceptance Criteria:**
    * A "Reflect" button is implemented in the primary UI.
    * A component test using **Vitest** verifies that clicking "Reflect" renders a new view containing both an editor pane (`TodayEditor`) and a chat pane (`ChatPane`).
    * The component test verifies that a "Close" button in the session view hides the session view.

---
**Ticket 8: Implement the Stubbed Chat Pane via Tauri Channels**
* **Goal:** Build the right-hand chat pane using Tauri's event system for asynchronous communication.
* **Acceptance Criteria:**
    * A headless function `get_initial_prompt(is_daily_log_empty: bool)` is created and unit tested.
    * A component test verifies that when a user sends a message, the frontend emits a Tauri event (`'chat-message'`).
    * A Rust event listener is created that, upon receiving `'chat-message'`, emits a `'chat-response'` event back with an "ECHO:" prefixed payload.
    * The component test verifies that the `ChatPane` correctly listens for and displays the echoed message.

### Milestone 4: Search V1 (Backend)

**Ticket 9: Implement Brute-Force Prefix/Hierarchical Search**
* **Goal:** Allow users to find all blocks tagged with a specific tag or any of its descendants.
* **Acceptance Criteria:**
    * A new Tauri command `search_prefix(query: String) -> Vec<u32>` is created.
    * A unit test for the search logic asserts that `search_prefix("#project")` returns the IDs for blocks tagged with `#project:sightline` and `#project:home`.

---
**Ticket 10: Implement Brute-Force Infix Search**
* **Goal:** Allow users to find all blocks where a tag contains a specific substring.
* **Acceptance Criteria:**
    * A new Tauri command `search_infix(query: String) -> Vec<u32>` is created.
    * A unit test asserts that `search_infix("shop")` returns the ID for a block tagged with `#project:home:shop`.

---
**Ticket 11: Implement Brute-Force Autocomplete Search**
* **Goal:** Provide a list of matching tags as the user types.
* **Acceptance Criteria:**
    * A new Tauri command `autocomplete_tag(query: String) -> Vec<TagSuggestion>` is created, where each suggestion includes a `name` and optional `color`.
    * A unit test asserts that `autocomplete_tag("#pro")` returns structured suggestions containing `"#project:sightline"` and other canonical tags.
