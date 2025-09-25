Of course. Here is a comprehensive engineering specification designed to be an unambiguous guide for refactoring the `Timeline` edit logic.

-----

## Engineering Spec: Refactoring `Timeline` Edit Logic

### 1\. Goal

This document outlines the required refactoring of the `Timeline::apply_ops` function. The current implementation is a correct but inefficient placeholder. The goal is to replace it with a highly performant implementation that leverages the `SumTree`'s logarithmic-time editing capabilities directly, using its `Cursor` API.

This refactor is critical for ensuring the application remains responsive and scalable as a user's `Timeline` grows over many months or years.

### 2\. The Problem with the Current Implementation

The current `apply_ops` function is not performant for the following reason:

```rust
// In Timeline::apply_ops...
let mut entries = self.tree.items(()); // O(N) operation
// ... manual operations on the Vec ...
self.tree = SumTree::from_iter(entries, ()); // O(N) operation
```

On every edit, this code **drains the entire tree into a `Vec`**, manually manipulates the `Vec`, and then **rebuilds the entire `SumTree` from scratch**. Both of these are O(N) operations, where N is the total number of entries in the `Timeline`. This completely negates the performance benefits of using a B-tree structure like the `SumTree` in the first place.

### 3\. The Solution: A Trait-Based Approach

The solution is to perform all edit operations directly on the `SumTree` using its `Cursor` API, which provides O(log N) performance for seeks and splices.

To ensure a clean separation of concerns, this logic will be encapsulated in a new trait, `EditableTimeline`. The `SumTree<LogEntry>` type will then implement this trait. This approach keeps the core editing logic tightly coupled with the data structure it operates on, while allowing the `Timeline` struct to remain focused on higher-level concerns like versioning and persistence.

### 4\. Detailed Specification

#### 4.1. The `EditableTimeline` Trait

A new trait must be created to define the interface for applying text operations.

```rust
// in src-tauri/src/timeline.rs

use crate::api::TextOperation; // Assuming api.rs holds the shared types

// Trait defining the core editing functionality
pub trait EditableTimeline {
    fn apply_ops(&mut self, ops: &[TextOperation], date_for_inserts: NaiveDate) -> Result<(), ApplyOpsError>;
}
```

#### 4.2. The `Dimension` for Seeking by Character

The `TextOperation` variants use character offsets (`position`, `start_position`). To use the `SumTree`'s `seek` method, we must define a `Dimension` that allows us to navigate by character count.

```rust
// in src-tauri/src/timeline.rs

use sum_tree::{Dimension, Bias};

// A newtype wrapper for usize to represent a character-based dimension.
#[derive(Clone, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
pub struct Chars(pub usize);

// Implementation of the Dimension trait for our Chars type.
impl<'a> Dimension<'a, TimelineSummary> for Chars {
    fn zero(_: ()) -> Self {
        Chars(0)
    }

    fn add_summary(&mut self, summary: &'a TimelineSummary, _: ()) {
        self.0 += summary.total_chars;
    }
}
```

#### 4.3. Implementing the Trait for `SumTree<LogEntry>`

The `SumTree<LogEntry>` will implement `EditableTimeline`. The logic inside `apply_ops` will not drain the tree. Instead, it will iterate through the operations and, for each one, use a `Cursor` to perform the edit directly on the tree's structure.

**This is the core of the task.** The implementation should follow this logic:

```rust
// in src-tauri/src/timeline.rs

impl EditableTimeline for SumTree<LogEntry> {
    fn apply_ops(
        &mut self,
        ops: &[TextOperation],
        date_for_inserts: NaiveDate,
    ) -> Result<(), ApplyOpsError> {
        // Process operations sequentially. Note: For simplicity in this PoC,
        // we assume character offsets in subsequent operations refer to the state
        // of the document *after* the previous operation has been applied.
        // A more complex implementation might adjust offsets, but this is sufficient.
        for op in ops {
            match op {
                TextOperation::Insert { position, text } => {
                    // 1. Create a cursor that seeks by Chars.
                    let mut cursor = self.cursor::<Chars>(());

                    // 2. Seek to the insertion position.
                    //    Use Bias::Right to insert *after* the character at the position.
                    if !cursor.seek(&Chars(*position), Bias::Right) {
                        // Handle the edge case where the position is out of bounds.
                        // This can happen if inserting at the very end of the document.
                        // The seek will return false but position the cursor at the end.
                        // We must check if the cursor's final position matches.
                        if cursor.start().0 != *position {
                           return Err(ApplyOpsError::InvalidPosition { position: *position });
                        }
                    }

                    // 3. Create the prefix tree by slicing up to the cursor.
                    let mut new_tree = cursor.slice(&Chars(*position), Bias::Left);

                    // 4. Push the new LogEntry containing the inserted text.
                    new_tree.push(
                        LogEntry {
                            date: date_for_inserts,
                            text: text.clone(),
                        },
                        (),
                    );

                    // 5. Append the rest of the original tree (the suffix).
                    new_tree.append(cursor.suffix(), ());

                    // 6. Replace the old tree with the newly constructed one.
                    *self = new_tree;
                }
                TextOperation::Delete { start_position, end_position } => {
                    // 1. Create the cursor.
                    let mut cursor = self.cursor::<Chars>(());

                    // 2. Create the prefix by slicing up to the start of the deletion.
                    let mut new_tree = cursor.slice(&Chars(*start_position), Bias::Left);

                    // 3. Seek the cursor past the deleted region.
                    if !cursor.seek(&Chars(*end_position), Bias::Left) {
                        if cursor.start().0 != *end_position {
                            return Err(ApplyOpsError::InvalidRange { start: *start_position, end: *end_position });
                        }
                    }

                    // 4. Append the suffix (the part of the tree after the deletion).
                    new_tree.append(cursor.suffix(), ());

                    // 5. Replace the old tree.
                    *self = new_tree;
                }
            }
        }

        Ok(())
    }
}
```

#### 4.4. Updating the `Timeline` Struct

The `Timeline::apply_ops` function will be simplified to a wrapper that handles version checking and then calls the new trait method on its internal `tree`.

```rust
// In src-tauri/src/timeline.rs

impl Timeline {
    // ... other methods ...

    // REVISED apply_ops method
    pub fn apply_ops(
        &mut self,
        base_version: u64,
        ops: &[TextOperation],
    ) -> Result<u64, ApplyOpsError> {
        if base_version != self.version {
            return Err(ApplyOpsError::VersionMismatch {
                expected: self.version,
                actual: base_version,
            });
        }

        if ops.is_empty() {
            return Ok(self.version);
        }

        // For now, stamp all new entries with today's date.
        // This will be refined when the check-in flow is wired up.
        let today = chrono::Utc::now().date_naive();

        // Call the new, performant trait method.
        self.tree.apply_ops(ops, today)?;

        self.version += 1;
        Ok(self.version)
    }
}
```

### 5\. Rationale for Keeping the Version Vector

The `base_version` check is a form of optimistic concurrency control. It is **not optional**. It is the critical safeguard that prevents lost updates when edits are being processed asynchronously. While less critical in a local-only v0, it is **absolutely essential for the future multi-device sync feature**. Removing it now would require re-architecting the sync logic later. It must remain.

### 6\. Acceptance Criteria

The refactor is considered complete when the following headless criteria are met:

1.  A Rust unit test for the `Chars` dimension can be written and passes.
2.  A Rust unit test for `SumTree::apply_ops` can successfully apply a single `Insert` operation and the resulting tree has the correct content.
3.  A Rust unit test for `SumTree::apply_ops` can successfully apply a single `Delete` operation that spans a single `LogEntry`.
4.  A Rust unit test for `SumTree::apply_ops` can successfully apply a `Delete` operation that spans multiple `LogEntry` items.
5.  All existing tests for the `Timeline` struct continue to pass without modification.


## Benchmark Suite Design


The goal is to prove that edit performance remains fast regardless of document size, confirming the O(log N) complexity of the `SumTree` implementation.

### 1\. Setup

First, use `cargo add` to add the necessary development dependencies to your `Cargo.toml`:

```toml
[dev-dependencies]
criterion = { version = "...", features = ["html_reports"] }
proptest = "..."
```

Then, create a new file at `benches/timeline_benches.rs`.

### 2\. `proptest` Strategy for Operations

We need to generate realistic, random `TextOperation`s. `proptest` is perfect for this. We'll create a strategy that, given a document's character length, generates a valid insert or delete operation.

```rust
// In benches/timeline_benches.rs

use proptest::prelude::*;

// Proptest strategy to generate a single, valid TextOperation
// for a document of a given character length.
fn arb_op(doc_len: usize) -> impl Strategy<Value = TextOperation> {
    // Operations can be either an insert or a delete
    prop_oneof![
        // Strategy for Inserts
        (0..=doc_len, ".{1,10}").prop_map(|(pos, text)| TextOperation::Insert {
            position: pos,
            text: text,
        }),
        // Strategy for Deletes
        (0..doc_len).prop_flat_map(move |start| {
            (start..=doc_len).prop_map(move |end| TextOperation::Delete {
                start_position: start,
                end_position: end,
            })
        }),
    ]
}
```

### 3\. `criterion` Benchmark Structure

The benchmark will measure the performance of applying a single, random operation to `Timeline` documents of varying sizes. This will clearly show how performance scales with document size.

```rust
// In benches/timeline_benches.rs

use criterion::{criterion_group, criterion_main, Criterion, BenchmarkId};
use sightline::timeline::{Timeline, EditableTimeline}; // Assuming your types
use proptest::strategy::ValueTree;
use proptest::test_runner::TestRunner;

fn apply_ops_benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("Timeline.apply_ops");
    let mut runner = TestRunner::default();

    // Benchmark against several document sizes
    for size in [1_000, 10_000, 100_000, 1_000_000].iter() {
        // Create a large, baseline timeline document of the target size
        let mut timeline = Timeline::default();
        let initial_text = "a".repeat(*size);
        timeline.apply_ops(&[TextOperation::Insert { position: 0, text: initial_text }], chrono::Utc::now().date_naive()).unwrap();

        // Use the proptest strategy to generate a random operation
        let op = arb_op(*size).new_tree(&mut runner).unwrap().current();

        group.bench_with_input(BenchmarkId::from_parameter(size), &timeline, |b, tl| {
            // b.iter_with_setup clones the large timeline for each run
            // to ensure the benchmark is not measuring repeated edits on the same object.
            b.iter_with_setup(
                || tl.clone(),
                |mut cloned_tl| {
                    cloned_tl.apply_ops(&[op.clone()], chrono::Utc::now().date_naive())
                }
            );
        });
    }
    group.finish();
}

criterion_group!(benches, apply_ops_benchmark);
criterion_main!(benches);
```

### 4\. Running and Interpreting

Run the benchmarks with `cargo bench`. `criterion` will generate an HTML report in the `target/criterion` directory.

When you open the report, you should see a graph for the `Timeline.apply_ops` group. If the refactor is successful, the line should be nearly flat, demonstrating that the time taken to apply an edit does not grow significantly with the document size.

-----

Now that we have the design for the benchmark suite, I can generate the full Rust code for this `timeline_benches.rs` file. It would include the necessary `use` statements, the `proptest` strategies, and the `criterion` group setup, ready for you to run. Would you like that?
