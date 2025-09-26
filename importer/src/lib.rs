use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, NaiveDate, Utc};
use clap::Parser;
use serde::Serialize;
use sightline_lib::timeline::{Tag, TagRegistry, TaggedBlock};
use tracing::info;
use walkdir::WalkDir;

#[derive(Debug, Parser, Clone)]
#[command(
    name = "sightline-importer",
    author,
    version,
    about = "Import existing journal and project notes into a Sightline timeline snapshot",
    long_about = None
)]
pub struct Cli {
    /// Path to the source vault (e.g., an Obsidian directory)
    #[arg(long, value_name = "SOURCE_DIR")]
    pub source: PathBuf,

    /// Destination file for the generated timeline snapshot
    #[arg(long, value_name = "OUTPUT_FILE")]
    pub output: PathBuf,
}

#[derive(Debug, Serialize)]
struct ImportSnapshot {
    version: u64,
    blocks: Vec<TaggedBlock>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tag_registry: Vec<Tag>,
}

pub fn run(cli: Cli) -> Result<()> {
    let source_root = ensure_directory(&cli.source)
        .with_context(|| format!("source directory '{}' is invalid", cli.source.display()))?;

    let journal_dir = source_root.join("journal");
    ensure_directory(&journal_dir)
        .with_context(|| format!("journal directory '{}' is missing", journal_dir.display()))?;

    let projects_dir = source_root.join("projects");
    ensure_directory(&projects_dir)
        .with_context(|| format!("projects directory '{}' is missing", projects_dir.display()))?;

    if let Some(parent) = cli.output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create output parent directory '{}'",
                    parent.display()
                )
            })?;
        }
    }

    let mut registry = TagRegistry::new();
    let mut blocks = Vec::new();

    collect_journal_entries(&journal_dir, &mut registry, &mut blocks)?;
    collect_project_entries(&projects_dir, &mut registry, &mut blocks)?;

    blocks.sort_by(|a, b| a.date.cmp(&b.date));

    let mut tags: Vec<Tag> = registry.iter().cloned().collect();
    tags.sort_by(|a, b| a.id.cmp(&b.id));

    let snapshot = ImportSnapshot {
        version: 0,
        blocks,
        tag_registry: tags,
    };

    let json = serde_json::to_vec_pretty(&snapshot)?;
    fs::write(&cli.output, json)
        .with_context(|| format!("failed to write snapshot to '{}'", cli.output.display()))?;

    info!(
        target: "sightline::importer",
        source = %source_root.display(),
        output = %cli.output.display(),
        blocks = snapshot.blocks.len(),
        tags = snapshot.tag_registry.len(),
        "importer completed"
    );

    Ok(())
}

fn collect_journal_entries(
    journal_dir: &Path,
    registry: &mut TagRegistry,
    blocks: &mut Vec<TaggedBlock>,
) -> Result<()> {
    let journal_tag = registry
        .intern_path(["type", "journal"])
        .ok_or_else(|| anyhow!("failed to intern #type:journal"))?;

    let mut files: Vec<PathBuf> = fs::read_dir(journal_dir)
        .with_context(|| {
            format!(
                "failed to read journal directory '{}'",
                journal_dir.display()
            )
        })?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| is_markdown(path))
        .collect();
    files.sort();

    for path in files {
        let file_stem = path
            .file_stem()
            .and_then(OsStr::to_str)
            .ok_or_else(|| anyhow!("journal entry '{}' has an invalid name", path.display()))?;

        let date = parse_journal_date(file_stem)
            .with_context(|| format!("failed to parse date from journal entry '{file_stem}'.md"))?;

        let text = fs::read_to_string(&path)
            .with_context(|| format!("failed to read journal entry '{}'", path.display()))?;

        blocks.push(TaggedBlock {
            date,
            text,
            tags: vec![journal_tag],
        });
    }

    Ok(())
}

fn collect_project_entries(
    projects_dir: &Path,
    registry: &mut TagRegistry,
    blocks: &mut Vec<TaggedBlock>,
) -> Result<()> {
    let project_root_tag = registry.intern_segment(None, "project");
    let project_note_tag = registry
        .intern_path(["type", "project-note"])
        .ok_or_else(|| anyhow!("failed to intern #type:project-note"))?;

    let mut entries = Vec::new();
    for entry in WalkDir::new(projects_dir) {
        let entry = entry.with_context(|| {
            format!(
                "failed to walk projects directory '{}'",
                projects_dir.display()
            )
        })?;

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.into_path();
        if !is_markdown(&path) {
            continue;
        }

        entries.push(path);
    }

    entries.sort();

    for path in entries {
        let relative = path.strip_prefix(projects_dir).with_context(|| {
            format!("failed to strip projects prefix from '{}'", path.display())
        })?;

        let text = fs::read_to_string(&path)
            .with_context(|| format!("failed to read project note '{}'", path.display()))?;
        let date = file_modified_date(&path).with_context(|| {
            format!("failed to read modification date for '{}'", path.display())
        })?;

        let mut tags = vec![project_root_tag, project_note_tag];
        let mut parent_tag = Some(project_root_tag);

        if let Some(dir_path) = relative.parent() {
            for component in dir_path.components() {
                if let Component::Normal(name) = component {
                    let segment = match normalize_tag_segment(&name.to_string_lossy()) {
                        Some(segment) => segment,
                        None => continue,
                    };

                    let tag_id = registry.intern_segment(parent_tag, &segment);
                    tags.push(tag_id);
                    parent_tag = Some(tag_id);
                }
            }
        }

        tags.sort_unstable();
        tags.dedup();

        blocks.push(TaggedBlock { date, text, tags });
    }

    Ok(())
}

fn ensure_directory(path: &Path) -> Result<&Path> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("failed to read metadata for '{}'", path.display()))?;

    if !metadata.is_dir() {
        anyhow::bail!("'{}' is not a directory", path.display());
    }

    Ok(path)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn parse_journal_date(name: &str) -> Result<NaiveDate> {
    let trimmed = name.trim();
    let normalized = trimmed.trim_matches('.');

    let candidates = [normalized, &normalized.replace("Sept", "Sep")];
    let formats = ["%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"];

    for candidate in candidates.iter() {
        for format in formats.iter() {
            if let Ok(date) = NaiveDate::parse_from_str(candidate, format) {
                return Ok(date);
            }
        }
    }

    Err(anyhow!("unable to parse journal date from '{name}'"))
}

fn file_modified_date(path: &Path) -> Result<NaiveDate> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("failed to read metadata for '{}'", path.display()))?;
    let modified = metadata
        .modified()
        .with_context(|| format!("failed to read modification time for '{}'", path.display()))?;

    let datetime: DateTime<Utc> = DateTime::<Utc>::from(modified);
    Ok(datetime.date_naive())
}

fn normalize_tag_segment(segment: &str) -> Option<String> {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut result = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            result.push(lower);
            last_dash = false;
        } else if !last_dash {
            result.push('-');
            last_dash = true;
        }
    }

    while result.ends_with('-') {
        result.pop();
    }

    while result.starts_with('-') {
        result.remove(0);
    }

    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::time::SystemTime;

    use assert_fs::prelude::*;
    use chrono::{NaiveDateTime, NaiveTime};
    use clap::CommandFactory;
    use filetime::FileTime;

    #[derive(Debug, serde::Deserialize)]
    struct Snapshot {
        version: u64,
        blocks: Vec<TaggedBlock>,
        #[serde(default)]
        tag_registry: Vec<Tag>,
    }

    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn run_errors_when_source_missing() {
        let temp = assert_fs::TempDir::new().expect("temp dir");
        let output = temp.child("timeline.json");

        let cli = Cli {
            source: temp.child("missing").path().to_path_buf(),
            output: output.path().to_path_buf(),
        };

        let result = run(cli);
        assert!(result.is_err(), "expected missing directory error");
    }

    #[test]
    fn run_imports_journal_and_project_notes() {
        let temp = assert_fs::TempDir::new().expect("temp dir");
        let vault = temp.child("vault");
        let journal = vault.child("journal");
        journal.create_dir_all().expect("create journal");
        let projects = vault.child("projects");
        projects.create_dir_all().expect("create projects");

        let journal_entry = journal.child("Sept 14, 2025.md");
        journal_entry
            .write_str("Morning reflection")
            .expect("write journal");

        let project_dir = projects.child("Sightline");
        project_dir.create_dir_all().expect("create project dir");
        let project_note = project_dir.child("Plan.md");
        project_note
            .write_str("Project plan notes")
            .expect("write project note");

        let project_date = NaiveDate::from_ymd_opt(2024, 5, 1).unwrap();
        let project_time =
            NaiveDateTime::new(project_date, NaiveTime::from_hms_opt(12, 0, 0).unwrap());
        let system_time: SystemTime =
            DateTime::<Utc>::from_naive_utc_and_offset(project_time, Utc).into();
        filetime::set_file_mtime(project_note.path(), FileTime::from_system_time(system_time))
            .expect("set mtime");

        let output = temp.child("out/timeline.json");
        let cli = Cli {
            source: vault.path().to_path_buf(),
            output: output.path().to_path_buf(),
        };

        run(cli).expect("run importer");

        let snapshot: Snapshot =
            serde_json::from_str(&fs::read_to_string(output.path()).expect("read snapshot"))
                .expect("parse snapshot");

        assert_eq!(snapshot.version, 0);
        assert_eq!(snapshot.blocks.len(), 2);
        assert!(
            snapshot
                .tag_registry
                .iter()
                .all(|tag| tag.color.as_ref().is_some())
        );

        let tag_names = build_tag_name_map(&snapshot.tag_registry);

        let journal_date = NaiveDate::from_ymd_opt(2025, 9, 14).unwrap();
        let journal_block = snapshot
            .blocks
            .iter()
            .find(|block| block.date == journal_date)
            .expect("journal block");
        let journal_tags = tags_as_names(journal_block, &tag_names);
        assert!(journal_tags.contains(&"type:journal".to_string()));

        let project_block = snapshot
            .blocks
            .iter()
            .find(|block| block.date == project_date)
            .expect("project block");
        let project_tags = tags_as_names(project_block, &tag_names);
        assert!(project_tags.contains(&"type:project-note".to_string()));
        assert!(project_tags.contains(&"project".to_string()));
        assert!(project_tags.contains(&"project:sightline".to_string()));
    }

    fn build_tag_name_map(tags: &[Tag]) -> HashMap<u32, String> {
        let mut map = HashMap::new();
        for tag in tags {
            if let Some(name) = resolve_full_name(tags, tag.id) {
                map.insert(tag.id, name);
            }
        }
        map
    }

    fn resolve_full_name(tags: &[Tag], id: u32) -> Option<String> {
        let mut segments = Vec::new();
        let mut current = Some(id);
        let mut guard = 0usize;
        while let Some(tag_id) = current {
            guard += 1;
            if guard > tags.len() + 1 {
                return None;
            }
            let tag = tags.iter().find(|candidate| candidate.id == tag_id)?;
            segments.push(tag.name.clone());
            current = tag.parent_id;
        }
        segments.reverse();
        Some(segments.join(":"))
    }

    fn tags_as_names(block: &TaggedBlock, tag_names: &HashMap<u32, String>) -> Vec<String> {
        block
            .tags
            .iter()
            .filter_map(|id| tag_names.get(id).cloned())
            .collect()
    }
}
