use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::{cmp, env};

use crate::api::TextOperation;
use chrono::NaiveDate;
use dirs::config_dir;
use serde::{Deserialize, Serialize};
use sum_tree::{Bias, Dimension, Item, SumTree, Summary};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub date: NaiveDate,
    pub text: String,
}

impl LogEntry {
    fn char_count(&self) -> usize {
        self.text.chars().count()
    }

    fn byte_count(&self) -> usize {
        self.text.len()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TimelineSummary {
    pub total_bytes: usize,
    pub total_chars: usize,
    pub entry_count: usize,
    pub min_date: Option<NaiveDate>,
    pub max_date: Option<NaiveDate>,
}

impl Summary for TimelineSummary {
    type Context<'a> = ();

    fn zero((): ()) -> Self {
        Self::default()
    }

    fn add_summary(&mut self, summary: &Self, (): ()) {
        self.total_bytes += summary.total_bytes;
        self.total_chars += summary.total_chars;
        self.entry_count += summary.entry_count;
        self.min_date = match (self.min_date, summary.min_date) {
            (Some(current), Some(other)) => Some(cmp::min(current, other)),
            (None, other) => other,
            (current, None) => current,
        };
        self.max_date = match (self.max_date, summary.max_date) {
            (Some(current), Some(other)) => Some(cmp::max(current, other)),
            (None, other) => other,
            (current, None) => current,
        };
    }
}

impl Item for LogEntry {
    type Summary = TimelineSummary;

    fn summary(&self, (): ()) -> Self::Summary {
        TimelineSummary {
            total_bytes: self.byte_count(),
            total_chars: self.char_count(),
            entry_count: 1,
            min_date: Some(self.date),
            max_date: Some(self.date),
        }
    }
}

pub trait EditableTimeline {
    fn apply_ops(
        &mut self,
        ops: &[TextOperation],
        date_for_inserts: NaiveDate,
    ) -> Result<(), ApplyOpsError>;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
pub struct Chars(pub usize);

impl<'a> Dimension<'a, TimelineSummary> for Chars {
    fn zero(_: ()) -> Self {
        Self(0)
    }

    fn add_summary(&mut self, summary: &'a TimelineSummary, _: ()) {
        self.0 += summary.total_chars;
    }
}

impl EditableTimeline for SumTree<LogEntry> {
    fn apply_ops(
        &mut self,
        ops: &[TextOperation],
        date_for_inserts: NaiveDate,
    ) -> Result<(), ApplyOpsError> {
        for op in ops {
            match op {
                TextOperation::Insert { position, text } => {
                    apply_insert(self, *position, text, date_for_inserts)?;
                }
                TextOperation::Delete {
                    start_position,
                    end_position,
                } => {
                    apply_delete(self, *start_position, *end_position)?;
                }
            }
        }

        Ok(())
    }
}

fn apply_insert(
    tree: &mut SumTree<LogEntry>,
    position: usize,
    text: &str,
    date: NaiveDate,
) -> Result<(), ApplyOpsError> {
    if text.is_empty() {
        return Ok(());
    }

    let total_chars = tree.summary().total_chars;
    if position > total_chars {
        return Err(ApplyOpsError::InvalidPosition { position });
    }

    let mut cursor = tree.cursor::<Chars>(());
    let mut left_tree = cursor.slice(&Chars(position), Bias::Left);
    let consumed = cursor.start().0;
    let offset_in_item = position - consumed;

    if offset_in_item > 0 {
        let current = cursor
            .item()
            .ok_or(ApplyOpsError::InvalidPosition { position })?;
        let char_count = current.char_count();
        if offset_in_item > char_count {
            return Err(ApplyOpsError::InvalidPosition { position });
        }

        let (left_fragment, right_fragment) = split_at_char(&current.text, offset_in_item)
            .ok_or(ApplyOpsError::InvalidPosition { position })?;

        if !left_fragment.is_empty() {
            left_tree.push(
                LogEntry {
                    date: current.date,
                    text: left_fragment,
                },
                (),
            );
        }

        left_tree.push(
            LogEntry {
                date,
                text: text.to_string(),
            },
            (),
        );

        let mut right_tree = SumTree::new(());
        if !right_fragment.is_empty() {
            right_tree.push(
                LogEntry {
                    date: current.date,
                    text: right_fragment,
                },
                (),
            );
        }

        cursor.next();
        right_tree.append(cursor.suffix(), ());
        left_tree.append(right_tree, ());
    } else {
        left_tree.push(
            LogEntry {
                date,
                text: text.to_string(),
            },
            (),
        );
        left_tree.append(cursor.suffix(), ());
    }

    drop(cursor);
    *tree = left_tree;

    Ok(())
}

fn apply_delete(
    tree: &mut SumTree<LogEntry>,
    start: usize,
    end: usize,
) -> Result<(), ApplyOpsError> {
    if start == end {
        return Ok(());
    }

    if start > end {
        return Err(ApplyOpsError::InvalidRange { start, end });
    }

    let total_chars = tree.summary().total_chars;
    if start > total_chars || end > total_chars {
        return Err(ApplyOpsError::InvalidRange { start, end });
    }

    let mut prefix_cursor = tree.cursor::<Chars>(());
    let mut left_tree = prefix_cursor.slice(&Chars(start), Bias::Left);
    let consumed = prefix_cursor.start().0;
    let offset_in_item = start - consumed;

    if offset_in_item > 0 {
        let current = prefix_cursor
            .item()
            .ok_or(ApplyOpsError::InvalidRange { start, end })?;
        let char_count = current.char_count();
        if offset_in_item > char_count {
            return Err(ApplyOpsError::InvalidRange { start, end });
        }

        let (left_fragment, _right_fragment) = split_at_char(&current.text, offset_in_item)
            .ok_or(ApplyOpsError::InvalidRange { start, end })?;

        if !left_fragment.is_empty() {
            left_tree.push(
                LogEntry {
                    date: current.date,
                    text: left_fragment,
                },
                (),
            );
        }

        prefix_cursor.next();
    }

    let mut suffix_cursor = tree.cursor::<Chars>(());
    let _ = suffix_cursor.slice(&Chars(end), Bias::Left);
    let consumed_end = suffix_cursor.start().0;
    if consumed_end > end {
        return Err(ApplyOpsError::InvalidRange { start, end });
    }
    let tail_offset = end - consumed_end;

    let mut right_tree = SumTree::new(());
    if let Some(item) = suffix_cursor.item() {
        let char_count = item.char_count();
        if tail_offset > char_count {
            return Err(ApplyOpsError::InvalidRange { start, end });
        }

        let (_, tail) = split_at_char(&item.text, tail_offset)
            .ok_or(ApplyOpsError::InvalidRange { start, end })?;

        if !tail.is_empty() {
            right_tree.push(
                LogEntry {
                    date: item.date,
                    text: tail,
                },
                (),
            );
        }

        suffix_cursor.next();
    } else if tail_offset != 0 {
        return Err(ApplyOpsError::InvalidRange { start, end });
    }

    right_tree.append(suffix_cursor.suffix(), ());
    left_tree.append(right_tree, ());

    drop(prefix_cursor);
    drop(suffix_cursor);
    *tree = left_tree;

    Ok(())
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApplyOpsError {
    #[error("version mismatch: expected {expected}, got {actual}")]
    VersionMismatch { expected: u64, actual: u64 },
    #[error("invalid position: {position}")]
    InvalidPosition { position: usize },
    #[error("invalid range: {start}..{end}")]
    InvalidRange { start: usize, end: usize },
}

#[derive(Debug, thiserror::Error)]
pub enum TimelinePersistenceError {
    #[error("config directory unavailable")]
    MissingConfigDir,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

#[derive(Debug, Serialize, Deserialize)]
struct TimelineSnapshot {
    version: u64,
    entries: Vec<LogEntry>,
}

#[derive(Clone, Debug, Default)]
pub struct Timeline {
    tree: SumTree<LogEntry>,
    version: u64,
}

impl Timeline {
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn summary(&self) -> &TimelineSummary {
        self.tree.summary()
    }

    pub fn entry_count(&self) -> usize {
        self.summary().entry_count
    }

    pub fn content(&self) -> String {
        self.tree
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<String>()
    }

    pub fn log_for_date(&self, date: NaiveDate) -> Option<String> {
        let summary = self.summary();
        let min_date = summary.min_date?;
        let max_date = summary.max_date?;

        if date < min_date || date > max_date {
            return None;
        }

        let mut content = String::new();
        for entry in self.tree.iter() {
            if entry.date == date {
                content.push_str(entry.text.as_str());
            }
        }

        if content.is_empty() {
            None
        } else {
            Some(content)
        }
    }

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

        let today = chrono::Utc::now().date_naive();
        self.tree.apply_ops(ops, today)?;
        self.version += 1;
        Ok(self.version)
    }

    pub fn save(&self) -> Result<(), TimelinePersistenceError> {
        let path = get_storage_path()?;
        self.save_to_path(path)
    }

    pub fn save_to_path<P: AsRef<Path>>(&self, path: P) -> Result<(), TimelinePersistenceError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let snapshot = TimelineSnapshot {
            version: self.version,
            entries: self.tree.items(()),
        };

        let data = serde_json::to_vec_pretty(&snapshot)?;
        fs::write(path, data)?;
        Ok(())
    }

    pub fn load() -> Result<Self, TimelinePersistenceError> {
        let path = get_storage_path()?;
        Self::load_from_path(path)
    }

    pub fn load_from_path<P: AsRef<Path>>(path: P) -> Result<Self, TimelinePersistenceError> {
        let path = path.as_ref();
        match fs::read_to_string(path) {
            Ok(contents) => {
                let snapshot: TimelineSnapshot = serde_json::from_str(&contents)?;
                let tree = SumTree::from_iter(snapshot.entries, ());
                Ok(Self {
                    tree,
                    version: snapshot.version,
                })
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err.into()),
        }
    }
}

pub fn get_storage_path() -> Result<PathBuf, TimelinePersistenceError> {
    if let Ok(custom) = env::var("SIGHTLINE_TIMELINE_PATH") {
        return Ok(PathBuf::from(custom));
    }
    let base = config_dir().ok_or(TimelinePersistenceError::MissingConfigDir)?;
    Ok(base.join("sightline").join("timeline.json"))
}

fn split_at_char(input: &str, char_index: usize) -> Option<(String, String)> {
    if char_index == 0 {
        return Some((String::new(), input.to_string()));
    }

    let mut count = 0;
    for (byte, _) in input.char_indices() {
        if count == char_index {
            let (left, right) = input.split_at(byte);
            return Some((left.to_string(), right.to_string()));
        }
        count += 1;
    }

    if count == char_index {
        Some((input.to_string(), String::new()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::from_str;
    use std::env;
    use tempfile::tempdir;

    fn sample_insert(text: &str) -> TextOperation {
        TextOperation::Insert {
            position: 0,
            text: text.to_string(),
        }
    }

    #[test]
    fn chars_dimension_accumulates_character_counts() {
        let mut dimension = Chars::zero(());

        let summary_a = TimelineSummary {
            total_chars: 3,
            ..TimelineSummary::default()
        };
        dimension.add_summary(&summary_a, ());

        let summary_b = TimelineSummary {
            total_chars: 5,
            ..TimelineSummary::default()
        };
        dimension.add_summary(&summary_b, ());

        assert_eq!(dimension.0, 8);
    }

    #[test]
    fn editable_timeline_insert_inserts_text_at_position() {
        let base_date = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let entries = vec![LogEntry {
            date: base_date,
            text: "abcd".to_string(),
        }];

        let mut tree = SumTree::from_iter(entries, ());
        tree.apply_ops(
            &[TextOperation::Insert {
                position: 2,
                text: "XY".to_string(),
            }],
            base_date,
        )
        .expect("insert");

        let content: String = tree.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(content, "abXYcd");
    }

    #[test]
    fn editable_timeline_delete_within_entry_removes_characters() {
        let base_date = NaiveDate::from_ymd_opt(2024, 2, 1).unwrap();
        let entries = vec![LogEntry {
            date: base_date,
            text: "abcdef".to_string(),
        }];

        let mut tree = SumTree::from_iter(entries, ());
        tree.apply_ops(
            &[TextOperation::Delete {
                start_position: 2,
                end_position: 4,
            }],
            base_date,
        )
        .expect("delete");

        let content: String = tree.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(content, "abef");
    }

    #[test]
    fn editable_timeline_delete_spanning_entries_trims_correctly() {
        let date_a = NaiveDate::from_ymd_opt(2024, 3, 1).unwrap();
        let date_b = NaiveDate::from_ymd_opt(2024, 3, 2).unwrap();

        let entries = vec![
            LogEntry {
                date: date_a,
                text: "12345".to_string(),
            },
            LogEntry {
                date: date_b,
                text: "ABCDE".to_string(),
            },
        ];

        let mut tree = SumTree::from_iter(entries, ());
        tree.apply_ops(
            &[TextOperation::Delete {
                start_position: 3,
                end_position: 7,
            }],
            date_a,
        )
        .expect("delete across entries");

        let content: String = tree.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(content, "123CDE");
    }

    #[test]
    fn summary_aggregates_counts_and_dates() {
        let date_a = NaiveDate::from_ymd_opt(2024, 5, 1).unwrap();
        let date_b = NaiveDate::from_ymd_opt(2024, 5, 3).unwrap();

        let entry_a = LogEntry {
            date: date_a,
            text: "Hello".to_string(),
        };
        let entry_b = LogEntry {
            date: date_b,
            text: "世界".to_string(),
        };

        let mut summary = entry_a.summary(());
        let other_summary = entry_b.summary(());
        sum_tree::Summary::add_summary(&mut summary, &other_summary, ());

        assert_eq!(summary.entry_count, 2);
        assert_eq!(summary.total_chars, 7);
        assert_eq!(summary.total_bytes, 5 + "世界".len());
        assert_eq!(summary.min_date, Some(date_a));
        assert_eq!(summary.max_date, Some(date_b));
    }

    #[test]
    fn apply_insert_updates_content_and_version() {
        let mut timeline = Timeline::default();

        let new_version = timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: "Happy New Year!".to_string(),
                }],
            )
            .expect("insert succeeds");

        assert_eq!(new_version, 1);
        assert_eq!(timeline.version(), 1);
        assert_eq!(timeline.content(), "Happy New Year!");
        assert_eq!(timeline.entry_count(), 1);
        assert_eq!(timeline.summary().min_date, timeline.summary().max_date);
        assert!(timeline.summary().min_date.is_some());
    }

    #[test]
    fn apply_delete_removes_text() {
        let mut timeline = Timeline::default();

        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: "abcdef".to_string(),
                }],
            )
            .expect("initial insert succeeds");

        let new_version = timeline
            .apply_ops(
                1,
                &[TextOperation::Delete {
                    start_position: 2,
                    end_position: 4,
                }],
            )
            .expect("delete succeeds");

        assert_eq!(new_version, 2);
        assert_eq!(timeline.version(), 2);
        assert_eq!(timeline.content(), "abef");
        assert_eq!(timeline.summary().total_chars, 4);
    }

    #[test]
    fn apply_delete_spanning_entries_truncates_correctly() {
        let mut timeline = Timeline::default();

        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: "12345".to_string(),
                }],
            )
            .expect("first insert succeeds");

        let position = timeline.summary().total_chars;
        timeline
            .apply_ops(
                1,
                &[TextOperation::Insert {
                    position,
                    text: "ABCDE".to_string(),
                }],
            )
            .expect("second insert succeeds");

        let new_version = timeline
            .apply_ops(
                2,
                &[TextOperation::Delete {
                    start_position: 3,
                    end_position: 7,
                }],
            )
            .expect("delete succeeds");

        assert_eq!(new_version, 3);
        assert_eq!(timeline.version(), 3);
        assert_eq!(timeline.content(), "123CDE");
        assert_eq!(timeline.summary().total_chars, 6);
    }

    #[test]
    fn apply_delete_out_of_bounds_returns_error() {
        let mut timeline = Timeline::default();

        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: "short".to_string(),
                }],
            )
            .expect("insert succeeds");

        let result = timeline.apply_ops(
            1,
            &[TextOperation::Delete {
                start_position: 0,
                end_position: 10,
            }],
        );

        assert_eq!(
            result.expect_err("delete should fail"),
            ApplyOpsError::InvalidRange { start: 0, end: 10 }
        );
    }

    #[test]
    fn save_to_path_writes_snapshot() {
        let mut timeline = Timeline::default();
        timeline
            .apply_ops(0, &[sample_insert("Snapshot test")])
            .expect("apply insert");

        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("timeline.json");
        timeline.save_to_path(&path).expect("save timeline");

        let contents = std::fs::read_to_string(&path).expect("read snapshot");
        let snapshot: TimelineSnapshot = from_str(&contents).expect("parse snapshot");

        assert_eq!(snapshot.version, timeline.version());
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].text, "Snapshot test");
    }

    #[test]
    fn load_from_path_restores_state() {
        let mut timeline = Timeline::default();
        timeline
            .apply_ops(0, &[sample_insert("Restored state")])
            .expect("apply insert");

        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("timeline.json");
        timeline.save_to_path(&path).expect("save timeline");

        let loaded = Timeline::load_from_path(&path).expect("load timeline");

        assert_eq!(loaded.version(), timeline.version());
        assert_eq!(loaded.content(), timeline.content());
        assert_eq!(loaded.entry_count(), timeline.entry_count());
    }

    #[test]
    fn load_missing_file_returns_default() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("timeline.json");

        let loaded = Timeline::load_from_path(&path).expect("load timeline");

        assert_eq!(loaded.version(), 0);
        assert_eq!(loaded.entry_count(), 0);
    }

    #[test]
    fn save_and_load_with_env_path() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("timeline.json");
        env::set_var("SIGHTLINE_TIMELINE_PATH", &path);
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                env::remove_var("SIGHTLINE_TIMELINE_PATH");
            }
        }
        let _reset = Reset;

        let mut timeline = Timeline::default();
        timeline
            .apply_ops(0, &[sample_insert("Env roundtrip")])
            .expect("apply insert");

        timeline.save().expect("save timeline");

        let loaded = Timeline::load().expect("load timeline");
        assert_eq!(loaded.version(), timeline.version());
        assert_eq!(loaded.content(), timeline.content());
    }

    #[test]
    fn missing_config_dir_error_message() {
        let message = TimelinePersistenceError::MissingConfigDir.to_string();
        assert_eq!(message, "config directory unavailable");
    }
}
