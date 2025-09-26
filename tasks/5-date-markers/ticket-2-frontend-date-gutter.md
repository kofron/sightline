# Ticket: Replace Sidebar with Date Gutter Overlay

## Goal
Remove the legacy sidebar and render inline date markers so users can see chronological boundaries while scrolling the timeline.

## Acceptance Criteria
- `TimelineWorkspace` no longer renders the left sidebar; the main editor expands to fill the width.
- A new gutter overlay component displays `M/D/YY` labels at the top of the document and wherever `BlockMetadata` dates change.
- Labels update after edits when `list_blocks` refreshes, and remain aligned during scroll.
- Vitest coverage asserts marker placement for representative block metadata.

## Notes
- Helper utilities (`formatShortDate`, `computeMarkers`) are unit-tested in `tests/date-gutter-overlay.test.ts`.

## Implementation Notes
- Use an absolutely positioned overlay anchored to the `relative` editor container.
- Map each block offset to a DOM position via Lexical hooks (e.g., node key lookups or `getClientRects`). Cache results to avoid layout thrash.
- Format dates with a shared helper (e.g., `formatShortDate(dateString: string)`), including unit tests for edge cases (year change).
- Coordinate with the command-palette ticket to ensure Reflect access remains available.

## QA / Validation
- Manual: load a timeline with multiple days, confirm labels appear at boundaries and stay aligned while scrolling and editing.
- Automated: Vitest component test feeding deterministic metadata arrays; update snapshots as needed.
