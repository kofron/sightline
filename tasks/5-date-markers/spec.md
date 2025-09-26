# Timeline Date Markers

## Purpose
Define how the editor replaces the existing timeline sidebar with inline date markers so users can understand which portions of the document belong to each day while scrolling through mixed-date content.

## User Stories
- As a user reading today’s notes, I should see today’s date once at the top of the document rather than a persistent sidebar.
- As I scroll through older entries, the gutter should surface compact date labels (`M/D/YY`) precisely where the content transitions to a different day so I never lose track of chronology.
- When the page contains only a single day, the gutter should show that date at the top and omit redundant labels.
- Navigating via “focus date” or historical scroll should keep date markers aligned with the underlying content so I can confirm I’m viewing the correct day.

## Current State (research)
- `TimelineWorkspace` renders a fixed left sidebar with a rotated badge and “Today” button, independent of the actual document content (`src/components/TimelineWorkspace.tsx:153-210`).
- The editor receives only raw markdown text (`document_content`) with no per-block metadata; date awareness exists solely in the Rust `TaggedBlock` struct (`src-tauri/src/timeline.rs:132`).
- `list_blocks` exposes block offsets and tag IDs but not the associated `NaiveDate`, so the frontend cannot tell where dates change (`src-tauri/src/timeline.rs:704-721`).
- Date formatting helpers already exist for API calls (`formatDateForApi`) and UI display (`formatDateForDisplay`) but assume the sidebar layout and current-day focus (`src/components/TimelineWorkspace.tsx:41-55`).
- Tests do not cover any UI that reacts to date boundaries; Vitest suites concentrate on sync, tags, and chat experiences (`tests/`).

-## Interaction and UX Notes
- Remove the dedicated left sidebar column; the editor canvas should reclaim the horizontal space and the old “Reflect” button moves into the command palette (implemented with `cmdk`).
- Introduce a narrow gutter (aligning with the current padding) that renders date labels only at boundaries:
  - The first visible block displays its date label at the top of the document.
  - When the next block’s date differs, render a new label immediately above that block.
  - Subsequent blocks sharing the same date render without additional labels.
- Date format: `M/D/YY` (no leading zeros). Internationalization can be revisited later; follow the short U.S. style for v0.
- Labels should stick to their block even as content above changes (e.g., inserting text dated today does not shift historic labels until the backend reports a new block sequence).
- Styling should keep labels subtle (e.g., small-caps or muted text) to avoid overpowering the note content while remaining readable in dark mode.
- Static positioning is acceptable for v0; sticky headers can be explored later if needed.
- Ensure keyboard navigation and screen readers encounter the date markers in order; labels should be semantic (e.g., visually styled containers with `aria-label` hints) if straightforward to implement.
- When users focus a specific date via command palette, the viewport should render all blocks that share that date, and the first label encountered should match the requested date.
- Reflect session affordances should continue to rely on today’s date, but without the old “Today” button; consider alternative placement for jumping back to current day if needed (separate ticket).

## Implementation Ideas

### Frontend (React & Lexical)
- Remove the sidebar layout from `TimelineWorkspace` and adjust container flex rules so the editor occupies the full width.
- Maintain a client-side projection of block metadata that includes `date`, `startOffset`, and `endOffset`; derive date boundary positions from this metadata rather than parsing markdown.
- Render date labels via an absolutely positioned overlay anchored to the editor container; use Lexical DOM lookups keyed by block offsets to align each label with its block start.
- Introduce a helper that formats `NaiveDate` strings (from backend) into `M/D/YY` for display, sharing logic with tests to avoid drift.
- Watch for updates from `replaceAllBlocks` to recompute label positions whenever the backend emits new metadata (after edits or tag changes).
- Add Vitest coverage for the new gutter component: feed synthetic block metadata arrays and assert that labels appear at the expected offsets.

### Backend & Sync
- Extend `BlockMetadata` to include a serialized ISO date string (e.g., `date: String`) sourced from each `TaggedBlock` (`src-tauri/src/timeline.rs`).
- Update `list_blocks` command and tests to validate the new field, ensuring existing callers continue to function.
- Consider exposing a dedicated “current document dates” request if computing boundaries client-side becomes expensive, but start with the enriched `list_blocks` response.
- Verify snapshot persistence keeps block dates intact (already stored on `TaggedBlock`) so reloading doesn’t lose marker fidelity.

## Open Questions
- Should we provide a replacement for the “Today” button in the same milestone, or defer navigation shortcuts to a follow-up ticket?
- Do we need sticky headers (date labels that remain visible while scrolling a long same-date block), or is static positioning sufficient for v0?
- How should labels behave when focus mode filters the document to a subset of dates — do we still render boundaries for non-visible days?
- Are there accessibility requirements for announcing date transitions to screen readers beyond visually rendering the text?

## Questions & Current Answers

| Topic | Question | Findings / Decision |
| --- | --- | --- |
| Layout | Where should date markers live after removing the sidebar? | Reclaim sidebar width for content and draw compact labels in the left gutter adjacent to block starts. |
| Data source | How does the frontend learn block dates? | Extend `list_blocks` to return each block’s ISO date so React can map boundaries without parsing markdown. |
| Formatting | What date style do we ship first? | Use `M/D/YY` (no leading zeros) for parity with current short-date expectations; revisit localization later. |
| Updates | When do markers refresh? | Whenever `list_blocks` resolves, typically after document load and each successful edit flush; rely on the existing refresh hook in `TimelineWorkspace`. |
| Tests | How do we validate correctness? | Add Vitest coverage for the gutter renderer and Rust tests confirming `list_blocks` includes the new `date` field. |
| Legacy UI | What happens to the “Today” button and reflect controls? | Sidebar removal will hide the button; spec assumes a future ticket will reintroduce a shortcut elsewhere. Reflect overlay continues to appear when viewing today. |

## Spike Tickets

1. **SPIKE: Determine optimal DOM strategy for date gutters**  
   - Prototype rendering markers as absolutely positioned elements overlaying the editor versus inline wrappers around Lexical blocks.
   - Measure scroll sync fidelity (do labels drift on fast scroll?) and how each approach interacts with selection, copy/paste, and undo.
   - Document trade-offs, preferred approach, and any Lexical APIs/hooks required to anchor labels to block positions.

2. **SPIKE: Extend block metadata with dates**  
   - Branch off and add a `date: String` field to `BlockMetadata`, plumb it through `Timeline::list_blocks`, and wire it into `commands::list_blocks`.
   - Update Rust unit/integration tests to assert the new field, and run `cargo test` to verify no regressions.
   - Review payload size/performance impact (e.g., sample document with thousands of blocks) and ensure older clients ignore the extra field safely.

3. **SPIKE: Accessibility review for date markers**  
   - Build a quick prototype with the chosen DOM strategy and evaluate screen-reader output (VoiceOver/NVDA) for date announcements.
   - Identify the minimal ARIA attributes needed to describe boundaries without duplicate narration and note any follow-up tasks.

4. **SPIKE: Reflect command palette migration**  
 - Evaluate the existing command palette implementation (cmdk) and outline how to move the Reflect affordance from the sidebar to the palette.
  - Confirm required API hooks, keyboard shortcuts, and how the command integrates with existing focus-date commands.

## Implementation Tickets

1. **Backend: Emit dates in block metadata**  
   - Extend `BlockMetadata` with a `date: String` derived from each `TaggedBlock`’s `NaiveDate` and serialize it through `Timeline::list_blocks` and `commands::list_blocks`.
   - Update Rust unit/integration tests to assert the new field and ensure existing consumers tolerate the additive payload.

2. **Frontend: Replace sidebar with gutter overlay**  
   - Remove the sidebar layout in `TimelineWorkspace`, expose an overlay component that positions date labels beside blocks using the new metadata, and format labels as `M/D/YY`.
   - Refresh markers on block metadata updates and cover the behaviour with Vitest stories/tests.

3. **Accessibility: Announce date boundaries**  
   - Add SR-friendly text (e.g., visually hidden spans or `aria-labelledby`) so screen readers announce “Entries dated …” before each boundary, and document manual verification steps.

4. **Command palette: Move Reflect & focus actions**  
   - Implement the `cmdk` palette, register `meta+k`, surface “Reflect”, “Today”, and date-focus commands, and wire them to existing handlers so the sidebar button can be removed confidently.
