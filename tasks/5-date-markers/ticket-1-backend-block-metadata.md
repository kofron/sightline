# Ticket: Emit Dates in Block Metadata

## Goal
Expose block-level dates to the frontend by extending the `list_blocks` command so the new gutter overlay can align markers with the correct content.

## Acceptance Criteria
- `BlockMetadata` in `src-tauri/src/timeline.rs` includes a `date: String` field serialized as `YYYY-MM-DD`.
- `Timeline::list_blocks` populates the field from each `TaggedBlock`’s `NaiveDate`.
- `commands::list_blocks` returns the extended payload without breaking existing consumers.
- Rust unit/integration tests (including `src-tauri/tests/commands.rs`) assert the new field.

## Implementation Notes
- Use `block.date.to_string()` or an explicit `format("%Y-%m-%d")` to ensure stable output.
- Maintain ordering guarantees and ensure additive changes stay backward-compatible.
- Re-run `cargo fmt` and `cargo test --workspace` after modifications.

## QA / Validation
- Existing tests should cover regression; add specific assertions in command tests for the new field (`list_blocks_command_returns_ranges`).
- Optionally add a targeted unit test that validates serialization of `BlockMetadata`.
