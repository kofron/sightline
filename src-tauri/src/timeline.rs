use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::{cmp, env};

use chrono::NaiveDate;
use dirs::config_dir;
use serde::{Deserialize, Serialize};
use sum_tree::{Item, SumTree, Summary};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineInsert {
    pub position: usize,
    pub date: NaiveDate,
    pub text: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApplyOpsError {
    #[error("version mismatch: expected {expected}, got {actual}")]
    VersionMismatch { expected: u64, actual: u64 },
    #[error("invalid position: {position}")]
    InvalidPosition { position: usize },
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
        inserts: &[TimelineInsert],
    ) -> Result<u64, ApplyOpsError> {
        if base_version != self.version {
            return Err(ApplyOpsError::VersionMismatch {
                expected: self.version,
                actual: base_version,
            });
        }

        if inserts.is_empty() {
            return Ok(self.version);
        }

        let mut entries = self.tree.items(());

        for TimelineInsert {
            position,
            date,
            text,
        } in inserts
        {
            insert_text(&mut entries, *position, date, text.clone())?;
        }

        self.tree = SumTree::from_iter(entries, ());
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

fn insert_text(
    entries: &mut Vec<LogEntry>,
    position: usize,
    date: &NaiveDate,
    text: String,
) -> Result<(), ApplyOpsError> {
    let mut cursor = 0usize;
    let mut index = 0usize;

    while index < entries.len() {
        let entry_chars = entries[index].char_count();
        if position <= cursor + entry_chars {
            let offset = position - cursor;
            if offset == 0 {
                entries.insert(index, LogEntry { date: *date, text });
                return Ok(());
            } else if offset == entry_chars {
                entries.insert(index + 1, LogEntry { date: *date, text });
                return Ok(());
            } else {
                let existing_date = entries[index].date;
                let (left, right) = split_at_char(&entries[index].text, offset)
                    .ok_or(ApplyOpsError::InvalidPosition { position })?;
                entries[index].text = left;
                entries.insert(index + 1, LogEntry { date: *date, text });
                entries.insert(
                    index + 2,
                    LogEntry {
                        date: existing_date,
                        text: right,
                    },
                );
                return Ok(());
            }
        }

        cursor += entry_chars;
        index += 1;
    }

    if position == cursor {
        entries.push(LogEntry { date: *date, text });
        Ok(())
    } else {
        Err(ApplyOpsError::InvalidPosition { position })
    }
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

    fn sample_insert(text: &str) -> TimelineInsert {
        TimelineInsert {
            position: 0,
            date: NaiveDate::from_ymd_opt(2024, 12, 31).unwrap(),
            text: text.to_string(),
        }
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
        summary.add_summary(&other_summary, ());

        assert_eq!(summary.entry_count, 2);
        assert_eq!(summary.total_chars, 7);
        assert_eq!(summary.total_bytes, 5 + "世界".len());
        assert_eq!(summary.min_date, Some(date_a));
        assert_eq!(summary.max_date, Some(date_b));
    }

    #[test]
    fn apply_insert_updates_content_and_version() {
        let mut timeline = Timeline::default();
        let date = NaiveDate::from_ymd_opt(2024, 12, 31).unwrap();

        let new_version = timeline
            .apply_ops(
                0,
                &[TimelineInsert {
                    position: 0,
                    date,
                    text: "Happy New Year!".to_string(),
                }],
            )
            .expect("insert succeeds");

        assert_eq!(new_version, 1);
        assert_eq!(timeline.version(), 1);
        assert_eq!(timeline.content(), "Happy New Year!");
        assert_eq!(timeline.entry_count(), 1);
        assert_eq!(timeline.summary().min_date, Some(date));
        assert_eq!(timeline.summary().max_date, Some(date));
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
