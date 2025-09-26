# Ticket: Move Reflect & Date Actions into cmdk Palette

## Goal
Adopt a `cmdk`-powered command palette so Reflect and date navigation remain accessible after the sidebar is removed.

## Acceptance Criteria
- A global `cmdk` palette opens with `meta+k` (or `ctrl+k` on Windows) and lists commands including “Reflect”, “Today”, and “Focus date…”.
- Selecting “Reflect” triggers the existing `openReflectSession` flow.
- Selecting “Today” (if provided) invokes `jumpToToday`.
- Selecting “Focus date…” prompts for a date and uses the existing backend focus mechanisms (stub for now if necessary).
- Sidebar reflect button is removed without loss of functionality.
- Palette styling approximates Linear’s command palette (badge, shortcuts, list highlighting) using shadcn primitives.

## Implementation Notes
- Create a palette component that renders inside `TimelineWorkspace`, wired to state via context or props.
- Reuse existing React hooks for reflect/focus to avoid duplicating logic.
- Consider a lightweight command registry for future commands (tags, search, etc.).

## QA / Validation
- Manual: Open palette with keyboard shortcut, confirm commands execute, and ensure overlay behaves in dark mode.
- Automated: Add a React Testing Library test verifying the palette renders and invokes callbacks when commands are selected.
