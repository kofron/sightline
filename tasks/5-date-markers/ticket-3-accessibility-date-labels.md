# Ticket: Announce Date Boundaries for Assistive Tech

## Status
**Deferred** — we’re prioritizing the command palette migration first and will return to this accessibility polish afterward.

## Acceptance Criteria
- Each date boundary renders accessible text (e.g., visually hidden span with "Entries dated M/D/YY") or links the label via `aria-labelledby` to the associated content container.
- Screen readers announce date changes before the corresponding blocks when navigating sequentially.
- Manual accessibility checklist documents VoiceOver/NVDA observations.

## Implementation Notes
- Consider using `aria-hidden="true"` on the visual label while providing a sibling `span` with `sr-only` styling.
- If using `aria-labelledby`, ensure each block container receives a stable ID matching the label.
- Coordinate with the gutter overlay logic to avoid extra layout work when adding hidden elements.

## QA / Validation
- Manual testing on macOS VoiceOver and Windows NVDA (or Narrator) verifying that moving through the document reads the correct date before block text.
- Optional automated axe/aria checks where applicable.
