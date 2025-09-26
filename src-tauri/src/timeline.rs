use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::{cmp, env};

use crate::{api::TextOperation, tag_palette};
use bloomfilter::Bloom;
use chrono::NaiveDate;
use dirs::config_dir;
use serde::{Deserialize, Serialize};
use sum_tree::{Bias, Dimension, Item, SumTree, Summary};

const TAG_FILTER_CAPACITY: usize = 256;
const TAG_FILTER_FALSE_POSITIVE_RATE: f64 = 0.01;
const TAG_FILTER_SEED: [u8; 32] = [0; 32];

fn new_tag_filter() -> Bloom<u32> {
    Bloom::new_for_fp_rate_with_seed(
        TAG_FILTER_CAPACITY,
        TAG_FILTER_FALSE_POSITIVE_RATE,
        &TAG_FILTER_SEED,
    )
    .expect("failed to create tag bloom filter")
}

fn union_tag_filters(target: &mut Bloom<u32>, source: &Bloom<u32>) {
    if source.is_empty() {
        return;
    }

    if target.is_empty() {
        *target = source.clone();
        return;
    }

    let mut target_bytes = target.to_bytes();
    let source_bytes = source.as_slice();
    assert_eq!(
        target_bytes.len(),
        source_bytes.len(),
        "tag bloom filters must have matching sizes",
    );

    let bit_bytes = ((target.len() as usize) + 7) / 8;
    let header_len = target_bytes.len() - bit_bytes;

    for (dst, src) in target_bytes[header_len..]
        .iter_mut()
        .zip(&source_bytes[header_len..])
    {
        *dst |= *src;
    }

    *target = Bloom::from_bytes(target_bytes).expect("failed to rebuild tag bloom filter");
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub id: u32,
    pub name: String,
    pub parent_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagSuggestion {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagDescriptor {
    pub id: u32,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockMetadata {
    pub index: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    #[serde(default)]
    pub tags: Vec<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct TagRegistry {
    tags: HashMap<u32, Tag>,
    index: HashMap<Option<u32>, HashMap<String, u32>>,
    next_id: u32,
}

impl TagRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.tags.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tags.is_empty()
    }

    pub fn get_tag(&self, id: u32) -> Option<&Tag> {
        self.tags.get(&id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Tag> {
        self.tags.values()
    }

    pub fn find_id(&self, parent_id: Option<u32>, name: &str) -> Option<u32> {
        self.index
            .get(&parent_id)
            .and_then(|by_name| by_name.get(name))
            .copied()
    }

    pub fn intern_segment(&mut self, parent_id: Option<u32>, name: &str) -> u32 {
        self.intern_segment_with_id(parent_id, name, None)
    }

    pub fn intern_path<'a, I>(&mut self, segments: I) -> Option<u32>
    where
        I: IntoIterator<Item = &'a str>,
    {
        let mut parent_id = None;
        let mut last_id = None;

        for segment in segments.into_iter() {
            let name = segment.trim();
            if name.is_empty() {
                continue;
            }

            let id = self.intern_segment(parent_id, name);
            parent_id = Some(id);
            last_id = Some(id);
        }

        last_id
    }

    pub fn intern_colon_path(&mut self, path: &str) -> Option<u32> {
        self.intern_path(path.split(':').filter_map(|segment| {
            let trimmed = segment.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }))
    }

    pub fn full_name(&self, id: u32) -> Option<String> {
        let mut segments = Vec::new();
        let mut current_id = Some(id);
        let mut guard = 0usize;

        while let Some(tag_id) = current_id {
            guard += 1;
            if guard > self.tags.len().saturating_add(1) {
                return None;
            }

            let tag = self.tags.get(&tag_id)?;
            segments.push(tag.name.clone());
            current_id = tag.parent_id;
        }

        if segments.is_empty() {
            return None;
        }

        segments.reverse();
        Some(segments.join(":"))
    }

    pub fn tag_ids_with_prefix(&self, query: &str) -> Vec<u32> {
        self.filter_tag_ids(query, |name, normalized| name.starts_with(normalized))
    }

    pub fn tag_ids_with_infix(&self, query: &str) -> Vec<u32> {
        self.filter_tag_ids(query, |name, normalized| name.contains(normalized))
    }

    pub fn autocomplete(&self, query: &str) -> Vec<TagSuggestion> {
        let normalized = Self::normalize_query(query);
        if normalized.is_empty() {
            return Vec::new();
        }

        let mut suggestions: Vec<TagSuggestion> = self
            .tag_names()
            .into_iter()
            .filter_map(|(id, name)| {
                let lower = name.to_lowercase();
                if !lower.starts_with(&normalized) {
                    return None;
                }

                let color = self.tags.get(&id).and_then(|tag| tag.color.clone());
                Some(TagSuggestion {
                    name: format!("#{name}"),
                    color,
                })
            })
            .collect();

        suggestions.sort_by(|a, b| a.name.cmp(&b.name));
        suggestions.dedup_by(|a, b| a.name == b.name);
        suggestions
    }

    fn filter_tag_ids<F>(&self, query: &str, predicate: F) -> Vec<u32>
    where
        F: Fn(&str, &str) -> bool,
    {
        let normalized = Self::normalize_query(query);
        if normalized.is_empty() {
            return Vec::new();
        }

        self.tag_names()
            .into_iter()
            .filter(|(_, name)| predicate(&name.to_lowercase(), &normalized))
            .map(|(id, _)| id)
            .collect()
    }

    fn tag_names(&self) -> Vec<(u32, String)> {
        self.tags
            .values()
            .filter_map(|tag| self.full_name(tag.id).map(|name| (tag.id, name)))
            .collect()
    }

    fn normalize_query(query: &str) -> String {
        query.trim().trim_start_matches('#').to_lowercase()
    }

    fn intern_segment_with_id(
        &mut self,
        parent_id: Option<u32>,
        name: &str,
        desired_id: Option<u32>,
    ) -> u32 {
        if let Some(existing) = self.find_id(parent_id, name) {
            return existing;
        }

        if let Some(parent) = parent_id {
            if !self.tags.contains_key(&parent) {
                panic!("parent tag {parent} does not exist");
            }
        }

        let id = desired_id.unwrap_or_else(|| self.next_available_id());

        if self.tags.contains_key(&id) {
            panic!("tag id {id} already exists");
        }

        let name_string = name.to_string();
        let tag = Tag {
            id,
            name: name_string.clone(),
            parent_id,
            color: Some(tag_palette::color_for(id).to_string()),
        };
        self.tags.insert(id, tag);
        self.index
            .entry(parent_id)
            .or_default()
            .insert(name_string, id);
        self.bump_next_id(id);
        id
    }

    fn next_available_id(&mut self) -> u32 {
        let mut id = self.next_id;
        while self.tags.contains_key(&id) {
            id = id.wrapping_add(1);
            if id == self.next_id {
                panic!("tag registry exhausted");
            }
        }
        self.next_id = id.wrapping_add(1);
        id
    }

    fn bump_next_id(&mut self, id: u32) {
        let next = id.wrapping_add(1);
        if self.next_id <= id {
            self.next_id = next;
        }
    }

    fn from_map(id_to_tag: HashMap<u32, String>) -> Self {
        let mut registry = Self::new();

        let mut entries: Vec<(u32, String)> = id_to_tag.into_iter().collect();
        entries.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));

        for (id, path) in entries {
            let mut parent = None;
            let segments: Vec<&str> = path.split(':').collect();
            if segments.is_empty() {
                continue;
            }

            for (index, segment) in segments.iter().enumerate() {
                let desired_id = if index == segments.len() - 1 {
                    Some(id)
                } else {
                    None
                };

                let trimmed = segment.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let tag_id = registry.intern_segment_with_id(parent, trimmed, desired_id);
                parent = Some(tag_id);
            }
        }

        registry
    }

    fn from_tags(tags: Vec<Tag>) -> Self {
        let mut registry = Self {
            tags: tags.into_iter().map(|tag| (tag.id, tag)).collect(),
            index: HashMap::new(),
            next_id: 0,
        };
        registry.ensure_tag_colors();
        registry.rebuild_indexes();
        registry
    }

    fn export(&self) -> Vec<Tag> {
        let mut tags: Vec<Tag> = self.tags.values().cloned().collect();
        tags.sort_by(|a, b| a.id.cmp(&b.id));
        tags
    }

    fn rebuild_indexes(&mut self) {
        self.index.clear();
        for tag in self.tags.values() {
            self.index
                .entry(tag.parent_id)
                .or_default()
                .insert(tag.name.clone(), tag.id);
        }

        self.next_id = self
            .tags
            .keys()
            .copied()
            .max()
            .map(|max| max.wrapping_add(1))
            .unwrap_or(0);

        self.ensure_tag_colors();
    }

    fn ensure_tag_colors(&mut self) {
        for (id, tag) in self.tags.iter_mut() {
            if tag.color.is_none() {
                tag.color = Some(tag_palette::color_for(*id).to_string());
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaggedBlock {
    pub date: NaiveDate,
    pub text: String,
    #[serde(default)]
    pub tags: Vec<u32>,
}

impl TaggedBlock {
    fn char_count(&self) -> usize {
        self.text.chars().count()
    }

    fn byte_count(&self) -> usize {
        self.text.len()
    }
}

impl Item for TaggedBlock {
    type Summary = TimelineSummary;

    fn summary(&self, (): ()) -> Self::Summary {
        let mut tags_filter = new_tag_filter();
        for tag_id in &self.tags {
            tags_filter.set(tag_id);
        }

        TimelineSummary {
            total_bytes: self.byte_count(),
            total_chars: self.char_count(),
            entry_count: 1,
            min_date: Some(self.date),
            max_date: Some(self.date),
            tags_filter,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TimelineSummary {
    pub total_bytes: usize,
    pub total_chars: usize,
    pub entry_count: usize,
    pub min_date: Option<NaiveDate>,
    pub max_date: Option<NaiveDate>,
    pub tags_filter: Bloom<u32>,
}

impl Default for TimelineSummary {
    fn default() -> Self {
        Self {
            total_bytes: 0,
            total_chars: 0,
            entry_count: 0,
            min_date: None,
            max_date: None,
            tags_filter: new_tag_filter(),
        }
    }
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
        union_tag_filters(&mut self.tags_filter, &summary.tags_filter);
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

impl EditableTimeline for SumTree<TaggedBlock> {
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
    tree: &mut SumTree<TaggedBlock>,
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
                TaggedBlock {
                    date: current.date,
                    text: left_fragment,
                    tags: current.tags.clone(),
                },
                (),
            );
        }

        left_tree.push(
            TaggedBlock {
                date,
                text: text.to_string(),
                tags: Vec::new(),
            },
            (),
        );

        let mut right_tree = SumTree::new(());
        if !right_fragment.is_empty() {
            right_tree.push(
                TaggedBlock {
                    date: current.date,
                    text: right_fragment,
                    tags: current.tags.clone(),
                },
                (),
            );
        }

        cursor.next();
        right_tree.append(cursor.suffix(), ());
        left_tree.append(right_tree, ());
    } else {
        left_tree.push(
            TaggedBlock {
                date,
                text: text.to_string(),
                tags: Vec::new(),
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
    tree: &mut SumTree<TaggedBlock>,
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
                TaggedBlock {
                    date: current.date,
                    text: left_fragment,
                    tags: current.tags.clone(),
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
                TaggedBlock {
                    date: item.date,
                    text: tail,
                    tags: item.tags.clone(),
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

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InternTagError {
    #[error("tag name cannot be empty")]
    Empty,
    #[error("tag must contain at least one valid segment")]
    Invalid,
    #[error("failed to resolve canonical name for tag id {0}")]
    MissingName(u32),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AssignBlockTagsError {
    #[error("block index {index} out of range")]
    InvalidBlock { index: usize },
    #[error(transparent)]
    Intern(#[from] InternTagError),
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
#[serde(untagged)]
enum TagRegistrySnapshot {
    Hierarchical(Vec<Tag>),
    Flat(HashMap<String, String>),
}

#[derive(Debug, Serialize, Deserialize)]
struct TimelineSnapshot {
    version: u64,
    #[serde(alias = "entries")]
    blocks: Vec<TaggedBlock>,
    #[serde(default)]
    tag_registry: Option<TagRegistrySnapshot>,
}

#[derive(Clone, Debug, Default)]
pub struct Timeline {
    tree: SumTree<TaggedBlock>,
    version: u64,
    tag_registry: TagRegistry,
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

    pub fn tag_registry(&self) -> &TagRegistry {
        &self.tag_registry
    }

    pub fn tag_registry_mut(&mut self) -> &mut TagRegistry {
        &mut self.tag_registry
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

    pub fn search_prefix(&self, query: &str) -> Vec<u32> {
        let tag_ids = self.tag_registry.tag_ids_with_prefix(query);
        self.block_ids_with_tags(&tag_ids)
    }

    pub fn search_infix(&self, query: &str) -> Vec<u32> {
        let tag_ids = self.tag_registry.tag_ids_with_infix(query);
        self.block_ids_with_tags(&tag_ids)
    }

    pub fn autocomplete_tags(&self, query: &str) -> Vec<TagSuggestion> {
        self.tag_registry.autocomplete(query)
    }

    pub fn intern_tag(&mut self, raw: &str) -> Result<TagDescriptor, InternTagError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(InternTagError::Empty);
        }

        let normalized = trimmed.trim_start_matches('#').trim();
        if normalized.is_empty() {
            return Err(InternTagError::Invalid);
        }

        let tag_id = self
            .tag_registry
            .intern_colon_path(normalized)
            .ok_or(InternTagError::Invalid)?;

        let tag = self
            .tag_registry
            .get_tag(tag_id)
            .cloned()
            .ok_or(InternTagError::MissingName(tag_id))?;

        let full_name = self
            .tag_registry
            .full_name(tag_id)
            .ok_or(InternTagError::MissingName(tag_id))?;

        let color = tag
            .color
            .clone()
            .unwrap_or_else(|| tag_palette::color_for(tag_id).to_string());

        Ok(TagDescriptor {
            id: tag_id,
            name: format!("#{full_name}"),
            color,
        })
    }

    pub fn assign_block_tags(
        &mut self,
        block_index: usize,
        tags: &[String],
    ) -> Result<Vec<TagDescriptor>, AssignBlockTagsError> {
        let mut blocks: Vec<TaggedBlock> = self.tree.iter().cloned().collect();
        let block = blocks
            .get_mut(block_index)
            .ok_or(AssignBlockTagsError::InvalidBlock { index: block_index })?;

        let mut descriptors = Vec::new();
        let mut tag_ids = Vec::new();

        for tag in tags {
            let descriptor = self.intern_tag(tag)?;
            tag_ids.push(descriptor.id);
            descriptors.push(descriptor);
        }

        block.tags = tag_ids;

        self.tree = SumTree::from_iter(blocks.into_iter(), ());

        Ok(descriptors)
    }

    pub fn list_tags(&self) -> Vec<TagDescriptor> {
        let mut descriptors = Vec::new();
        for tag in self.tag_registry.iter() {
            if let Some(name) = self.tag_registry.full_name(tag.id) {
                let color = tag
                    .color
                    .clone()
                    .unwrap_or_else(|| tag_palette::color_for(tag.id).to_string());
                descriptors.push(TagDescriptor {
                    id: tag.id,
                    name: format!("#{name}"),
                    color,
                });
            }
        }
        descriptors.sort_by(|a, b| a.name.cmp(&b.name));
        descriptors
    }

    pub fn list_blocks(&self) -> Vec<BlockMetadata> {
        let mut metadata = Vec::new();
        let mut offset: u32 = 0;
        for (index, block) in self.tree.iter().enumerate() {
            let char_count = u32::try_from(block.char_count()).unwrap_or(u32::MAX);
            let start = offset;
            let end = offset.saturating_add(char_count);
            metadata.push(BlockMetadata {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                start_offset: start,
                end_offset: end,
                tags: block.tags.clone(),
            });
            offset = end;
        }
        metadata
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

    fn block_ids_with_tags(&self, tag_ids: &[u32]) -> Vec<u32> {
        if tag_ids.is_empty() {
            return Vec::new();
        }

        let matching: HashSet<u32> = tag_ids.iter().copied().collect();

        self.tree
            .iter()
            .enumerate()
            .filter_map(|(index, block)| {
                if block.tags.iter().any(|tag| matching.contains(tag)) {
                    u32::try_from(index).ok()
                } else {
                    None
                }
            })
            .collect()
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

        let exported_tags = self.tag_registry.export();
        let snapshot = TimelineSnapshot {
            version: self.version,
            blocks: self.tree.items(()),
            tag_registry: if exported_tags.is_empty() {
                None
            } else {
                Some(TagRegistrySnapshot::Hierarchical(exported_tags))
            },
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
                let tree = SumTree::from_iter(snapshot.blocks, ());
                let tag_registry = match snapshot.tag_registry {
                    Some(TagRegistrySnapshot::Hierarchical(tags)) => TagRegistry::from_tags(tags),
                    Some(TagRegistrySnapshot::Flat(map)) => {
                        let parsed: HashMap<u32, String> = map
                            .into_iter()
                            .filter_map(|(id, tag)| id.parse::<u32>().ok().map(|id| (id, tag)))
                            .collect();
                        TagRegistry::from_map(parsed)
                    }
                    None => TagRegistry::new(),
                };
                Ok(Self {
                    tree,
                    version: snapshot.version,
                    tag_registry,
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
    fn tag_registry_assigns_unique_ids() {
        let mut registry = TagRegistry::new();
        let alpha = registry.intern_segment(None, "alpha");
        let beta = registry.intern_segment(None, "beta");

        assert_ne!(alpha, beta);
        assert_eq!(
            registry.get_tag(alpha).map(|tag| tag.name.as_str()),
            Some("alpha")
        );
        assert_eq!(
            registry.get_tag(beta).map(|tag| tag.name.as_str()),
            Some("beta")
        );
    }

    #[test]
    fn tag_registry_reuses_existing_id_for_same_tag() {
        let mut registry = TagRegistry::new();
        let first = registry
            .intern_path(["project", "sightline"])
            .expect("path id");
        let second = registry
            .intern_path(["project", "sightline"])
            .expect("path id");

        assert_eq!(first, second);
        let tag = registry.get_tag(first).expect("tag exists");
        assert_eq!(tag.name, "sightline");
        let parent = tag.parent_id.and_then(|id| registry.get_tag(id));
        assert_eq!(parent.map(|tag| tag.name.as_str()), Some("project"));
    }

    #[test]
    fn tag_registry_full_name_reconstructs_hierarchy() {
        let mut registry = TagRegistry::new();
        let id = registry
            .intern_path(["project", "sightline", "importer"])
            .expect("path id");

        assert_eq!(
            registry.full_name(id).as_deref(),
            Some("project:sightline:importer")
        );

        let child = registry.get_tag(id).unwrap();
        let parent = registry.get_tag(child.parent_id.unwrap()).unwrap();
        assert_eq!(parent.name, "sightline");
        let grandparent = registry.get_tag(parent.parent_id.unwrap()).unwrap();
        assert_eq!(grandparent.name, "project");
    }

    #[test]
    fn tag_registry_intern_colon_path_trims_segments() {
        let mut registry = TagRegistry::new();
        let id = registry
            .intern_colon_path(" project : sightline : importer ")
            .expect("path id");

        assert_eq!(
            registry.full_name(id).as_deref(),
            Some("project:sightline:importer")
        );
    }

    #[test]
    fn filter_cursor_prunes_blocks_without_matching_tag() {
        let tag_id = 42;
        let date = NaiveDate::from_ymd_opt(2024, 6, 1).unwrap();
        let blocks = vec![
            TaggedBlock {
                date,
                text: "First".to_string(),
                tags: Vec::new(),
            },
            TaggedBlock {
                date,
                text: "Tagged".to_string(),
                tags: vec![tag_id],
            },
            TaggedBlock {
                date,
                text: "Third".to_string(),
                tags: Vec::new(),
            },
        ];

        let tree = SumTree::from_iter(blocks, ());
        let mut cursor = tree.filter::<_, ()>((), |summary: &TimelineSummary| {
            summary.tags_filter.check(&tag_id)
        });

        cursor.next();
        let item = cursor.item().expect("cursor should point at tagged block");
        assert_eq!(item.text, "Tagged");

        cursor.next();
        assert!(cursor.item().is_none());
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
        let entries = vec![TaggedBlock {
            date: base_date,
            text: "abcd".to_string(),
            tags: Vec::new(),
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
        let entries = vec![TaggedBlock {
            date: base_date,
            text: "abcdef".to_string(),
            tags: Vec::new(),
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
            TaggedBlock {
                date: date_a,
                text: "12345".to_string(),
                tags: Vec::new(),
            },
            TaggedBlock {
                date: date_b,
                text: "ABCDE".to_string(),
                tags: Vec::new(),
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

        let tag_id = 7;
        let entry_a = TaggedBlock {
            date: date_a,
            text: "Hello".to_string(),
            tags: vec![tag_id],
        };
        let entry_b = TaggedBlock {
            date: date_b,
            text: "世界".to_string(),
            tags: Vec::new(),
        };

        let mut summary = entry_a.summary(());
        let other_summary = entry_b.summary(());
        sum_tree::Summary::add_summary(&mut summary, &other_summary, ());

        assert_eq!(summary.entry_count, 2);
        assert_eq!(summary.total_chars, 7);
        assert_eq!(summary.total_bytes, 5 + "世界".len());
        assert_eq!(summary.min_date, Some(date_a));
        assert_eq!(summary.max_date, Some(date_b));
        assert!(summary.tags_filter.check(&tag_id));
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
        assert_eq!(snapshot.blocks.len(), 1);
        assert_eq!(snapshot.blocks[0].text, "Snapshot test");
        assert!(snapshot.tag_registry.is_none());
    }

    #[test]
    fn save_to_path_includes_tag_hierarchy() {
        let mut timeline = Timeline::default();
        let project_id = timeline.tag_registry_mut().intern_segment(None, "project");
        let _child_id = timeline
            .tag_registry_mut()
            .intern_segment(Some(project_id), "sightline");

        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("timeline.json");
        timeline.save_to_path(&path).expect("save timeline");

        let contents = std::fs::read_to_string(&path).expect("read snapshot");
        let snapshot: TimelineSnapshot = from_str(&contents).expect("parse snapshot");

        let tags = match snapshot.tag_registry {
            Some(TagRegistrySnapshot::Hierarchical(tags)) => tags,
            other => panic!("unexpected tag registry format: {:?}", other),
        };

        assert_eq!(tags.len(), 2);
        let project = tags
            .iter()
            .find(|tag| tag.name == "project")
            .expect("project tag present");
        assert!(project.parent_id.is_none());

        let sightline = tags
            .iter()
            .find(|tag| tag.name == "sightline")
            .expect("sightline tag present");
        assert_eq!(sightline.parent_id, Some(project.id));
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
    fn load_legacy_flat_tag_registry() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("timeline.json");
        let legacy_snapshot = serde_json::json!({
            "version": 1,
            "blocks": [],
            "tag_registry": {
                "5": "project:sightline"
            }
        });
        std::fs::write(&path, legacy_snapshot.to_string()).expect("write legacy snapshot");

        let loaded = Timeline::load_from_path(&path).expect("load timeline");
        assert_eq!(loaded.version(), 1);
        assert_eq!(loaded.entry_count(), 0);
        assert_eq!(
            loaded.tag_registry().full_name(5).as_deref(),
            Some("project:sightline")
        );
    }

    #[test]
    fn search_prefix_returns_matching_blocks() {
        let date = NaiveDate::from_ymd_opt(2024, 8, 1).unwrap();
        let mut registry = TagRegistry::new();
        let project = registry.intern_segment(None, "project");
        let sightline = registry.intern_segment(Some(project), "sightline");
        let home = registry.intern_segment(Some(project), "home");
        let journal = registry
            .intern_path(["type", "journal"])
            .expect("journal tag");

        let blocks = vec![
            TaggedBlock {
                date,
                text: "Sightline plan".to_string(),
                tags: vec![sightline],
            },
            TaggedBlock {
                date,
                text: "Home renovation".to_string(),
                tags: vec![home],
            },
            TaggedBlock {
                date,
                text: "Daily reflection".to_string(),
                tags: vec![journal],
            },
        ];

        let timeline = Timeline {
            tree: SumTree::from_iter(blocks, ()),
            version: 0,
            tag_registry: registry,
        };

        assert_eq!(timeline.search_prefix("#project"), vec![0, 1]);
    }

    #[test]
    fn search_infix_finds_partial_matches() {
        let date = NaiveDate::from_ymd_opt(2024, 9, 2).unwrap();
        let mut registry = TagRegistry::new();
        let project = registry.intern_segment(None, "project");
        let sightline = registry.intern_segment(Some(project), "sightline");
        let research = registry.intern_segment(Some(project), "research");

        let blocks = vec![
            TaggedBlock {
                date,
                text: "Sightline planning".to_string(),
                tags: vec![sightline],
            },
            TaggedBlock {
                date,
                text: "Research notes".to_string(),
                tags: vec![research],
            },
        ];

        let timeline = Timeline {
            tree: SumTree::from_iter(blocks, ()),
            version: 0,
            tag_registry: registry,
        };

        assert_eq!(timeline.search_infix("sight"), vec![0]);
        assert_eq!(timeline.search_infix("search"), vec![1]);
    }

    #[test]
    fn autocomplete_tags_returns_suggestions() {
        let mut registry = TagRegistry::new();
        let project = registry.intern_segment(None, "project");
        let _sightline = registry.intern_segment(Some(project), "sightline");
        let _strategy = registry.intern_segment(Some(project), "strategy");
        let _journal = registry
            .intern_path(["type", "journal"])
            .expect("journal tag");

        let timeline = Timeline {
            tree: SumTree::new(()),
            version: 0,
            tag_registry: registry,
        };

        let results = timeline.autocomplete_tags("#pro");
        let names: Vec<_> = results
            .iter()
            .map(|suggestion| suggestion.name.as_str())
            .collect();
        assert!(names.contains(&"#project"));
        assert!(names.contains(&"#project:sightline"));
        assert!(names.contains(&"#project:strategy"));
        assert!(results.iter().all(|suggestion| suggestion.color.is_some()));

        let type_results = timeline.autocomplete_tags("#type:j");
        assert_eq!(
            type_results
                .iter()
                .map(|suggestion| suggestion.name.as_str())
                .collect::<Vec<_>>(),
            vec!["#type:journal"]
        );
        assert!(type_results
            .iter()
            .all(|suggestion| suggestion.color.is_some()));
    }

    #[test]
    fn intern_tag_creates_and_reuses_entries() {
        let mut timeline = Timeline::default();

        let first = timeline
            .intern_tag("#project:new")
            .expect("create project tag");
        assert_eq!(first.name, "#project:new");
        assert_eq!(first.id, 1);
        assert!(!first.color.is_empty());

        let reused = timeline
            .intern_tag("project:new")
            .expect("reuse existing tag");
        assert_eq!(reused.id, first.id);
        assert_eq!(reused.name, first.name);

        let other = timeline
            .intern_tag("type:journal")
            .expect("create second tag");
        assert_ne!(other.id, first.id);
        assert!(other.name.starts_with("#type"));
    }

    #[test]
    fn intern_tag_rejects_invalid_input() {
        let mut timeline = Timeline::default();
        assert_eq!(timeline.intern_tag("   "), Err(InternTagError::Empty));
        assert_eq!(timeline.intern_tag("#"), Err(InternTagError::Invalid));
    }

    #[test]
    fn assign_block_tags_updates_block() {
        let mut timeline = Timeline::default();
        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: "entry one\n".to_string(),
                }],
            )
            .expect("insert first entry");
        let position = timeline.summary().total_chars;
        timeline
            .apply_ops(
                1,
                &[TextOperation::Insert {
                    position,
                    text: "entry two".to_string(),
                }],
            )
            .expect("insert second entry");

        let descriptors = timeline
            .assign_block_tags(
                1,
                &["#project:alpha".to_string(), "type:journal".to_string()],
            )
            .expect("assign tags");

        assert_eq!(descriptors.len(), 2);
        let block = timeline.tree.iter().nth(1).expect("second block");
        assert_eq!(block.tags.len(), 2);
    }

    #[test]
    fn assign_block_tags_rejects_invalid_index() {
        let mut timeline = Timeline::default();
        let error = timeline.assign_block_tags(0, &[]).unwrap_err();
        assert_eq!(error, AssignBlockTagsError::InvalidBlock { index: 0 });
    }

    #[test]
    fn list_blocks_returns_offsets() {
        let mut timeline = Timeline::default();
        timeline
            .apply_ops(
                0,
                &[TextOperation::Insert {
                    position: 0,
                    text: "alpha\n".to_string(),
                }],
            )
            .expect("insert first block");
        let position = timeline.summary().total_chars;
        timeline
            .apply_ops(
                1,
                &[TextOperation::Insert {
                    position,
                    text: "beta".to_string(),
                }],
            )
            .expect("insert second block");

        let blocks = timeline.list_blocks();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].start_offset, 0);
        assert_eq!(blocks[0].end_offset, 6);
        assert_eq!(blocks[1].start_offset, blocks[0].end_offset);
        assert_eq!(blocks[1].end_offset, blocks[1].start_offset + 4);
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
