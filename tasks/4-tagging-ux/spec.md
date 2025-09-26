# Inline Tagging UX

## Purpose
Define the behaviour and supporting changes required to let users add hierarchical tags inline while typing, with autocomplete, keyboard navigation, and consistent visual styling.

## User Stories
- As a user editing in the middle of a paragraph, when I type `#` the editor should treat it as the start of a tag rather than a Markdown heading so I can keep writing without jumping to H1 formatting.
- As I continue typing after `#`, I should see matching tag suggestions pulled from my existing tag registry.
- I can use `ArrowUp` and `ArrowDown` to move through the suggestion list, press `Tab` to insert the highlighted suggestion, or press `Enter` to accept my current input even if it is new.
- When a tag is confirmed, it should remain in the text as `#tag`, be associated with the underlying block’s tag list, and display with a deterministic highlight colour to reinforce recognition.

## Current State (research)
- The Lexical editor loads Markdown shortcuts and list plugins; the Markdown transformer currently interprets `#` at the start of a line as Heading 1, which is the regression users observe (`src/editor/TimelineEditor.tsx:68`).
- Inline edits are reduced to pure text diffs; new blocks created by inserts do not receive any tags, resulting in `TaggedBlock { tags: Vec::new() }` for fresh content (`src-tauri/src/timeline.rs:338`, `src-tauri/src/timeline.rs:538`).
- The tag registry already supports hierarchical paths, prefix/infix search, and autocomplete that returns canonical `#name` strings (`src-tauri/src/timeline.rs:168`, `src-tauri/src/timeline.rs:751`).
- Tauri exposes `autocomplete_tag`, `search_prefix`, `search_infix`, `intern_tag`, `assign_block_tags`, `list_tags`, and `list_blocks`; the React workspace now seeds a tag cache on load (`src-tauri/src/lib.rs:107`, `src/components/TimelineWorkspace.tsx:25`).

## Interaction and UX Notes
- Trigger: typing `#` within a text node opens an inline suggestion popover anchored to the caret. The popover stays active until the user commits, cancels, or types whitespace/punctuation that ends the tag.
- Query capture: everything between the `#` and the first terminating character (`space`, `,`, `.`, newline) forms the autocomplete query, allowing colon-separated hierarchy segments.
- Keyboard behaviour:
  - `ArrowUp`/`ArrowDown`: cycle the highlighted suggestion (wrapping at ends).
  - `Tab`: insert the highlighted suggestion, prevent default focus change, and keep the caret after the inserted tag.
  - `Enter`: confirm the current input. If it matches a suggestion, use that tag; otherwise treat it as a request to create a new tag.
  - `Escape`: close the popover and leave the literal text untouched.
- Visuals: confirmed tags render as `#name` with a background colour chip (deterministic per tag) and accessible contrast; hovering reveals the full hierarchical path if truncated. Backend suggestions surface CSS `oklch(...)` strings in `TagSuggestion.color` so the chip renderer can apply them directly.

## Implementation Ideas

### Frontend (Lexical)
- Add a custom Lexical node or decorator to represent inline tags so we can render colour and store metadata separate from the raw text. `@lexical/hashtag` may serve as a base, but we likely need a bespoke node that tracks the resolved tag ID.
- Intercept `#` typing by adding a command listener or text node transform before the Markdown shortcut plugin runs, ensuring we suppress the heading shortcut and open our autocomplete flow when the caret is mid-line.
- Manage the suggestion popover with React state tied to Lexical selection updates. Debounce autocomplete invocations and cancel stale requests to avoid flooding the Tauri bridge.
- When the user commits a selection, replace the in-progress text range with our custom tag node, and ensure subsequent editing keeps it intact (allow backspace to revert to plain text when needed).

- ### Backend and Sync
- Extend the edit payload or introduce a parallel mutation so the frontend can attach tag IDs to the affected `TaggedBlock`. Today, `handle_edit` only applies textual diffs; we need either:
  1. A follow-up command like `assign_block_tags({ block_id, tag_ids })`, or
  2. Richer edit operations that carry metadata alongside text changes.
  3. A hybrid approach where the frontend delays sending the `Insert { … }` operation until the tag selection is finalized, bundling both the text and the resolved tag ID. This keeps the existing command surface but complicates later UX (e.g. retroactively tagging existing text), so we may choose to support it in parallel with broader metadata operations.
- Provide an endpoint to intern new tags when a user confirms a string that does not yet exist. This command should return `{ id, name, colour }` so the frontend can render immediately and update local caches.
- Decide where to compute colours: either hash the numeric `tag.id` client-side for deterministic palette mapping, or store a colour field in the registry snapshot. Persisting the colour on the Rust side keeps importer output and runtime consistent.
- Expose block metadata (`list_blocks`) that stays within the backend bounded context; the frontend consumes it as a read model today, with TODOs for incremental diffs once the backend can emit them.

## Open Questions
- How do we map inline positions back to `TaggedBlock` identifiers to keep assignments in sync when a block splits or merges during edits?
- Should `search_prefix` / `search_infix` start returning richer data (tag names + colours) to support future browsing UI, or do we keep responses string-only and maintain a tag metadata cache separately?
- What is the accessibility strategy for colour coding (contrast, patterns) and how do we expose tag metadata to screen readers within Lexical?

## Questions & Current Answers

| Topic | Question | Findings / Decision |
| --- | --- | --- |
| Tag lifecycle | Do we need to support tagging existing text, multiple blocks, or is inline-at-creation sufficient? | We will deliver inline tagging first, but should design the API so retroactive tagging of existing blocks is possible soon after (backend supports multiple tags per block). |
| Tag creation | Should new tags capture extra metadata? | Name-only is sufficient for v1. Palette support now comes from the shared LUT; no user-editable metadata yet. |
| Propagation | When a tag is created, when does it sync to other clients? | Tag creation must persist immediately (mutate registry + save) so other clients pick it up at next sync/start. |
| Editor state | Can blocks hold multiple inline tags and what happens on removal? | Yes, multiple chips per block. Removing a chip should drop the tag ID from that block but leave the tag in the registry. |
| Popover lifetime | Should the suggestion list persist if the caret moves? | Keep the popover active while the user moves via arrow keys (caret stays within the partial tag). A mouse click elsewhere should blur the editor selection, close the popover, and abandon the in-progress tag. |
| Paste behaviour | Should pasted `#foo` auto-tag? | Convert pasted tags into chips eventually, but acceptable to defer to a post-v1 enhancement. |
| Autocomplete matching | Prefix vs infix? | Use prefix matching (case-insensitive) for initial implementation; revisit infix once we add advanced querying. |
| Autocomplete payload | Should suggestions include metadata? | Inline list should show name + colour swatch; backend must return `{ name, color }` for each suggestion. |
| Registry scale | Do we need paging? | No immediate need; debounce requests client-side. |
| Metadata sync | Is it acceptable to call follow-up commands for tag assignment? | Yes. Support explicit tag assignment commands, while optionally delaying insert operations when it fits the inline flow. The `intern_tag` command now persists new tags immediately, and `assign_block_tags` records per-block tag IDs. |
| Block identity | How do we identify blocks to mutate tags? | Expose block indices/IDs via API so the frontend can reference specific `TaggedBlock`s when setting tags. Must re-evaluate after merges/splits. |
| Colour strategy | Where do colours come from? | Tags receive deterministic OKLCH colours from a shared LUT at creation time; future versions can swap in a generator. |
| Accessibility | Screen reader and contrast? | Provide meaningful `aria-label`/`aria-role` for chips and ensure palette meets WCAG; design to verify contrast. |
| Platform scope | Keyboard shortcuts on mobile/native? | Feature must work across desktop and mobile. Provide alternative interactions (tap selection) when hardware keyboard shortcuts are unavailable. |

## Spike Tickets

1. **SPIKE: Expose stable block identifiers for tag assignment**  
   Investigate how `SumTree<TaggedBlock>` handles indices during insert/delete, and determine the safest way to reference a block from the UI (index vs. synthetic ID). Review `src-tauri/src/timeline.rs` block iteration and tests.

2. **SPIKE: Design retroactive tag mutation API**  
   Explore adding a Tauri command for assigning/removing tag IDs on an existing block. Confirm how `AppState` and command wiring in `src-tauri/src/lib.rs` can support it and what persistence implications exist.

3. **SPIKE: Enrich autocomplete payload with palette data**  
   Assess changes needed for `TagRegistry::autocomplete_names` to return `{ name, color }`, including serialization to the frontend and any adjustments required for existing callers/tests.

4. **SPIKE: Confirm immediate persistence of new tags**  
   Trace `Timeline::save` usage to ensure a tag-creation command can safely call it without UI deadlocks. Document error handling patterns and whether asynchronous execution is needed.

5. **SPIKE: Palette storage strategy**  
   Decide where to persist OKLCH colour values (extend `Tag`, attach sidecar map, or new snapshot structure). Review `TimelineSnapshot` and importer snapshot formats for compatibility.

6. **SPIKE: Lexical interception for `#` and popover anchoring**  
   Prototype intercepting `#` before Markdown shortcuts and identify componentry for anchoring a popover to the caret (check existing components under `src/components`).

7. **SPIKE: Cross-platform input handling**  
   Verify how keyboard events propagate in desktop vs. mobile shells to ensure arrow/tab/enter behaviour can be adapted. Review any native wrappers or platform-specific code paths.

### Spike Findings

- **Block identifiers**: `TaggedBlock` has no intrinsic ID; the timeline currently references blocks by tree order. `Timeline::block_ids_with_tags` enumerates indices to return matching entries (`src-tauri/src/timeline.rs:777`). `SumTree` provides iterators and cursors but no stable identifier; any edit that inserts or deletes before a block shifts its index. To mutate tags safely we either need to address blocks by character range (via cursor) or introduce a synthetic `block_id` persisted with each `TaggedBlock`.
- **Retroactive tag mutation API**: Commands in `src-tauri/src/lib.rs:36` lock the timeline, mutate state, then call `timeline.save()`. Adding an `assign_block_tags` command would follow the same pattern, but `Timeline` currently lacks a helper to mutate an arbitrary block; we will need a new method (likely rebuilding the tree or using `SumTree` cursors) plus matching tests in `src-tauri/tests/commands.rs`.
- **Autocomplete payload enrichment**: `Timeline::autocomplete_tags` now returns structured `{ name, color? }` suggestions and the Tauri command forwards them; frontend still needs to consume the richer payload.
- **Immediate persistence**: `handle_edit` persists edits synchronously after applying operations (`src-tauri/src/lib.rs:50-55`). `Timeline::save` writes JSON to disk via `fs::write` (`src-tauri/src/timeline.rs:802-821`). Reusing this pattern for tag creation/assignment will keep behaviour consistent; these calls already run on the Tauri command thread.
- **Palette storage**: `Tag` currently serializes `id`, `name`, `parent_id` only (`src-tauri/src/timeline.rs:59`). Both timeline snapshots and importer output reuse this struct (`src-tauri/src/timeline.rs:675`, `importer/src/lib.rs:31`). Adding a colour requires extending `Tag` with `#[serde(default)] color: Option<TagColor>` and updating importer generation plus legacy loaders.
- **Lexical interception & popover anchoring**: `TimelineEditor` wires standard Lexical plugins but no custom command handlers (`src/editor/TimelineEditor.tsx:68-93`). We will need a plugin that registers key handlers before `MarkdownShortcutPlugin` to suppress heading conversion, and a UI component to render a caret-anchored popover (likely a new component; no existing caret overlay helpers in `src/components`).
- **Cross-platform input handling**: The codebase today targets Tauri (desktop) only; there are no platform-specific branches or mobile wrappers under `src` or `src-tauri`. Keyboard shortcuts can assume desktop behaviour, but we must plan additional input affordances (tap selection) for future mobile shells since no infrastructure exists yet.

## Tickets

- **TAG-001 Inline Tag Trigger & Popover Skeleton**  
  Build a Lexical plugin that intercepts `#` mid-text before markdown shortcuts fire, manages in-progress tag state, and renders a caret-anchored popover with keyboard handling (arrows keep it open, click blurs). Includes wiring a no-op suggestion list for now.  
  Findings: Must hook before `MarkdownShortcutPlugin` to avoid H1 conversion; no existing caret popover component in `src/components`.  
  Acceptance: Typing `#` mid-line opens a placeholder popover, heading shortcut is suppressed mid-line, arrow keys keep the popover open while the caret stays in the tag, mouse click elsewhere closes the popover and restores plain text.

- **TAG-002 Autocomplete API Upgrade (name + color)**  
  Extend `Tag` with `color`, update timeline/importer snapshot serialization, and adjust `autocomplete_tag` to return `{ name, color }`. Update tests/regressions.  
  Findings: Current API returns `Vec<String>` and tests (`src-tauri/tests/commands.rs:226`) expect strings; snapshots share the `Tag` struct with importer.  
  Acceptance: Autocomplete command returns an array of objects with `name` and `color`, existing tests updated, timeline/importer snapshot round-trips preserve colour values.

- **TAG-003 Tag Palette LUT Infrastructure**  
  Add an OKLCH palette lookup persisted with each tag and expose a helper to assign colours on new tag creation/import.  
  Findings: Palette must be stored with tags so importer output and runtime are consistent.  
  Acceptance: New tags receive deterministic colours from a documented palette, importer snapshots include colour data, helper util covered by unit tests. *(DONE – see `tag_palette.rs`, registry colour assignment, and importer snapshot test.)*

- **TAG-004 Tag Creation Command & Immediate Persistence**  
  Introduce a Tauri command (`intern_tag`) that interns/normalizes a tag, assigns a palette colour, saves the timeline, and returns `{ id, name, color }`.  
  Findings: Existing commands lock `AppState`, mutate, then call `timeline.save()` synchronously.  
  Acceptance: Command returns resolved tag metadata, duplicate requests reuse existing IDs, timeline JSON updates immediately, tests cover success and error paths. *(DONE – command exposed via Tauri, timeline helper returns coloured descriptors, and tests verify persistence.)*

- **TAG-005 Block Tag Assignment Support**  
  Provide a way to attach/detach tag IDs on an existing block, including stable identifiers and persistence.  
  Findings: Blocks are currently addressed by positional index; edits shift indices, so we may need synthetic IDs or character-range mapping.  
  Acceptance: Backend exposes an API to assign/remove tags on a block, handles invalid IDs gracefully, persistence verified via tests that include split/merge scenarios. *(DONE – `assign_block_tags` command rewrites the SumTree entry and saves immediately, with unit and command tests covering success/error paths.)*

- **TAG-006 Frontend Tag Chip Node & Rendering**  
  Create a custom Lexical decorator node that renders a confirmed tag chip with colour and accessibility affordances, and wires deletion back to the backend assignment API.  
  Findings: Node must store tag ID/name/colour so UI can render and signal removal accurately.  
  Acceptance: Confirmed tags display as coloured chips with appropriate `aria` labels, deleting the chip drops the block’s tag ID, visual regression covered with Storybook or unit snapshot.

- **TAG-007 Fetch & Cache Tag Metadata in UI**  
  Establish a client cache/store for tag metadata to power autocomplete and chip rendering, kept in sync after create/update commands.  
  Findings: UI currently never fetches tag data; new cache layer required.  
  Acceptance: App loads tag metadata on workspace init, caches respond to tag creation/assignment events, components consume cache without redundant invokes. *(DONE – `list_tags` command seeds a React tag store in `TimelineWorkspace`, and `intern_tag`/`assign_block_tags` return descriptors ready for upserts.)*

- **TAG-008 Retroactive Tagging UX**  
  Build UI affordances (e.g. selection toolbar, context menu) to tag existing blocks using the new backend API.  
  Findings: Requires block selection semantics not yet present in the editor.  
  Acceptance: Users can select existing content, add/remove tags, visual state updates immediately, backend reflects changes.

- **TAG-009 Paste-to-Tag Enhancement (post-v1)**  
  Detect pasted `#tag` sequences and convert them into chips using the autocomplete/create pipeline.  
  Findings: To be tackled after inline flow is stable; will reuse detection logic from TAG-001/006.  
  Acceptance: Pasting `#foo` mid-line converts to a tag chip (behind a feature flag if needed), tests cover both conversion and escape hatches.

- **TAG-010 Cross-Platform Interaction Support**  
  Ensure tagging UX works without hardware keyboards (touch interactions, on-screen controls) and prepare for future mobile shells.  
  Findings: No existing mobile wrappers; need tap-friendly popover actions.  
  Acceptance: Popover offers tappable list + confirm/cancel controls, keyboard shortcuts continue to work on desktop, QA sign-off on at least one touch environment (simulator).
