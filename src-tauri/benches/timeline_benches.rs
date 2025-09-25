use chrono::NaiveDate;
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::strategy::{Strategy, ValueTree};
use proptest::test_runner::TestRunner;
use sightline_lib::api::TextOperation;
use sightline_lib::timeline::{LogEntry, Timeline};
use sum_tree::{SumTree, TREE_BASE};

fn arb_op(doc_len: usize) -> BoxedStrategy<TextOperation> {
    let insert_strategy =
        (0..=doc_len, vec(any::<char>(), 1..=10)).prop_map(|(position, chars)| {
            let text: String = chars.into_iter().collect();
            TextOperation::Insert { position, text }
        });

    if doc_len == 0 {
        return insert_strategy.boxed();
    }

    let delete_strategy = (0..doc_len).prop_flat_map(move |start| {
        (start..=doc_len).prop_map(move |end| TextOperation::Delete {
            start_position: start,
            end_position: end,
        })
    });

    prop_oneof![insert_strategy, delete_strategy].boxed()
}

fn apply_ops_benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("timeline_apply_ops");
    let mut runner = TestRunner::default();

    for doc_len in [1_000usize, 10_000, 100_000, 1_000_000] {
        let mut timeline = Timeline::default();
        let initial_text = "a".repeat(doc_len);
        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: initial_text,
                }],
            )
            .expect("initialize timeline for benchmark");

        let op = arb_op(doc_len)
            .new_tree(&mut runner)
            .expect("generate operation")
            .current();

        group.bench_with_input(BenchmarkId::from_parameter(doc_len), &timeline, |b, tl| {
            b.iter_with_setup(
                || tl.clone(),
                |mut cloned_timeline| {
                    let base_version = cloned_timeline.version();
                    cloned_timeline
                        .apply_ops(base_version, &[op.clone()])
                        .expect("apply operation in benchmark");
                },
            );
        });
    }

    group.finish();
}

fn clone_benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("timeline_clone");

    for doc_len in [1_000usize, 10_000, 100_000, 1_000_000] {
        let mut timeline = Timeline::default();
        let initial_text = "a".repeat(doc_len);
        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: initial_text,
                }],
            )
            .expect("initialize timeline for clone benchmark");

        group.bench_with_input(BenchmarkId::from_parameter(doc_len), &timeline, |b, tl| {
            b.iter(|| tl.clone());
        });
    }

    group.finish();
}

fn node_split_benchmark(c: &mut Criterion) {
    const NODE_PRE_SPLIT_CAPACITY: usize = 2 * TREE_BASE;
    let date = NaiveDate::from_ymd_opt(2025, 9, 25).expect("valid benchmark date");

    c.bench_function("timeline_node_split", |b| {
        b.iter_with_setup(
            || {
                let mut tree = SumTree::<LogEntry>::new(());
                for _ in 0..NODE_PRE_SPLIT_CAPACITY {
                    tree.push(
                        LogEntry {
                            date,
                            text: "a".to_string(),
                        },
                        (),
                    );
                }
                tree
            },
            |mut tree| {
                tree.push(
                    LogEntry {
                        date,
                        text: "a".to_string(),
                    },
                    (),
                );
            },
        );
    });
}

fn append_only_benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("timeline_append_only");

    for doc_len in [1_000usize, 10_000, 100_000, 1_000_000] {
        let mut timeline = Timeline::default();
        let initial_text = "a".repeat(doc_len);
        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: initial_text,
                }],
            )
            .expect("initialize timeline for append benchmark");

        group.bench_with_input(BenchmarkId::from_parameter(doc_len), &timeline, |b, tl| {
            b.iter_with_setup(
                || tl.clone(),
                |mut cloned_timeline| {
                    let base_version = cloned_timeline.version();
                    let end_pos = cloned_timeline.summary().total_chars;
                    let op = TextOperation::Insert {
                        position: end_pos,
                        text: "append".to_string(),
                    };

                    cloned_timeline
                        .apply_ops(base_version, &[op])
                        .expect("append operation succeeds");
                },
            );
        });
    }

    group.finish();
}

fn delete_only_benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("timeline_delete_only");
    let mut runner = TestRunner::default();

    for doc_len in [1_000usize, 10_000, 100_000, 1_000_000] {
        let mut timeline = Timeline::default();
        let initial_text = "a".repeat(doc_len);
        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: initial_text,
                }],
            )
            .expect("initialize timeline for delete benchmark");

        let delete_strategy = (0..doc_len).prop_flat_map(move |start| {
            (start..=doc_len).prop_map(move |end| TextOperation::Delete {
                start_position: start,
                end_position: end,
            })
        });

        let op = delete_strategy
            .new_tree(&mut runner)
            .expect("generate delete op")
            .current();

        group.bench_with_input(BenchmarkId::from_parameter(doc_len), &timeline, |b, tl| {
            b.iter_with_setup(
                || tl.clone(),
                |mut cloned_timeline| {
                    let base_version = cloned_timeline.version();
                    cloned_timeline
                        .apply_ops(base_version, &[op.clone()])
                        .expect("delete operation succeeds");
                },
            );
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    apply_ops_benchmark,
    clone_benchmark,
    node_split_benchmark,
    append_only_benchmark,
    delete_only_benchmark
);
criterion_main!(benches);
