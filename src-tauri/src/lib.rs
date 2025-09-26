use std::sync::Mutex;

pub mod api;
pub mod chat;
mod tag_palette;
pub mod timeline;

pub struct AppState {
    timeline: Mutex<timeline::Timeline>,
}

impl AppState {
    pub fn new() -> Self {
        let timeline = timeline::Timeline::load().unwrap_or_default();
        Self {
            timeline: Mutex::new(timeline),
        }
    }

    pub fn get_timeline(&self) -> std::sync::MutexGuard<'_, timeline::Timeline> {
        self.timeline.lock().expect("timeline lock poisoned")
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

pub mod commands {
    use super::*;
    use chrono::NaiveDate;
    use serde::Serialize;
    use tauri::State;

    #[tauri::command]
    pub fn entry_count(state: State<AppState>) -> Result<usize, String> {
        let timeline = state.get_timeline();
        Ok(timeline.entry_count())
    }

    #[tauri::command]
    pub fn handle_edit(
        state: State<AppState>,
        payload: api::EditPayload,
    ) -> Result<api::EditResponse, String> {
        let mut timeline = state.get_timeline();
        let api::EditPayload { base_version, ops } = payload;

        match timeline.apply_ops(base_version, &ops) {
            Ok(new_version) => {
                if let Err(err) = timeline.save() {
                    tracing::warn!(?err, "failed to save timeline after edit");
                }
                Ok(api::EditResponse::Ok { new_version })
            }
            Err(timeline::ApplyOpsError::VersionMismatch { expected, .. }) => {
                Ok(api::EditResponse::Conflict {
                    server_version: expected,
                })
            }
            Err(err) => Err(err.to_string()),
        }
    }

    #[tauri::command]
    pub fn get_full_document(state: State<AppState>) -> Result<String, String> {
        let timeline = state.get_timeline();
        Ok(timeline.content())
    }

    #[derive(Debug, Serialize)]
    pub struct DocumentSnapshot {
        pub content: String,
        pub version: u64,
    }

    #[tauri::command]
    pub fn get_document_snapshot(state: State<AppState>) -> Result<DocumentSnapshot, String> {
        let timeline = state.get_timeline();
        Ok(DocumentSnapshot {
            content: timeline.content(),
            version: timeline.version(),
        })
    }

    #[tauri::command]
    pub fn get_log_for_date(state: State<AppState>, date: String) -> Result<String, String> {
        let parsed = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
            .map_err(|err| format!("invalid date format: {err}"))?;

        let timeline = state.get_timeline();
        Ok(timeline.log_for_date(parsed).unwrap_or_default())
    }

    #[tauri::command]
    pub fn search_prefix(state: State<AppState>, query: String) -> Result<Vec<u32>, String> {
        let timeline = state.get_timeline();
        Ok(timeline.search_prefix(&query))
    }

    #[tauri::command]
    pub fn search_infix(state: State<AppState>, query: String) -> Result<Vec<u32>, String> {
        let timeline = state.get_timeline();
        Ok(timeline.search_infix(&query))
    }

    #[tauri::command]
    pub fn autocomplete_tag(
        state: State<AppState>,
        query: String,
    ) -> Result<Vec<timeline::TagSuggestion>, String> {
        let timeline = state.get_timeline();
        Ok(timeline.autocomplete_tags(&query))
    }

    #[tauri::command]
    pub fn intern_tag(
        state: State<AppState>,
        tag: String,
    ) -> Result<timeline::TagDescriptor, String> {
        let mut timeline = state.get_timeline();
        let descriptor = timeline.intern_tag(&tag).map_err(|err| err.to_string())?;

        if let Err(err) = timeline.save() {
            tracing::warn!(?err, "failed to save timeline after interning tag");
            return Err(err.to_string());
        }

        Ok(descriptor)
    }

    #[tauri::command]
    pub fn assign_block_tags(
        state: State<AppState>,
        block_index: u32,
        tags: Vec<String>,
    ) -> Result<Vec<timeline::TagDescriptor>, String> {
        let mut timeline = state.get_timeline();
        let descriptors = timeline
            .assign_block_tags(block_index as usize, &tags)
            .map_err(|err| err.to_string())?;

        if let Err(err) = timeline.save() {
            tracing::warn!(?err, "failed to save timeline after assigning block tags");
            return Err(err.to_string());
        }

        Ok(descriptors)
    }

    #[tauri::command]
    pub fn list_tags(state: State<AppState>) -> Result<Vec<timeline::TagDescriptor>, String> {
        let timeline = state.get_timeline();
        Ok(timeline.list_tags())
    }

    #[tauri::command]
    pub fn list_blocks(state: State<AppState>) -> Result<Vec<timeline::BlockMetadata>, String> {
        let timeline = state.get_timeline();
        Ok(timeline.list_blocks())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            chat::register(app.handle().clone());
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::entry_count,
            commands::handle_edit,
            commands::get_full_document,
            commands::get_document_snapshot,
            commands::get_log_for_date,
            commands::search_prefix,
            commands::search_infix,
            commands::autocomplete_tag,
            commands::intern_tag,
            commands::assign_block_tags,
            commands::list_tags,
            commands::list_blocks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
