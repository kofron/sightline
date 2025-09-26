use serde_json::{json, Value};
use std::{
    env, fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard, OnceLock},
};
use tauri::{
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    WebviewWindow, WebviewWindowBuilder,
};
use tempfile::{tempdir, TempDir};

use sightline_lib::{commands, AppState};

static ENV_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> &'static Mutex<()> {
    ENV_MUTEX.get_or_init(|| Mutex::new(()))
}

struct TimelineEnvGuard {
    _dir: TempDir,
    path: PathBuf,
    _guard: MutexGuard<'static, ()>,
}

impl TimelineEnvGuard {
    fn new() -> Self {
        let guard = env_lock().lock().expect("lock env mutex");
        let dir = tempdir().expect("create temp dir");
        let path = dir.path().join("timeline.json");
        env::set_var("SIGHTLINE_TIMELINE_PATH", &path);
        Self {
            _dir: dir,
            path,
            _guard: guard,
        }
    }

    fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl Drop for TimelineEnvGuard {
    fn drop(&mut self) {
        env::remove_var("SIGHTLINE_TIMELINE_PATH");
    }
}

fn build_test_app() -> (
    tauri::App<tauri::test::MockRuntime>,
    WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = mock_builder()
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
        .build(mock_context(noop_assets()))
        .expect("failed to build app");

    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("failed to create webview window");

    (app, webview)
}

fn invoke_command(
    webview: &WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    payload: Value,
) -> Value {
    let response = get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: payload.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .expect("command invocation failed");

    match response {
        tauri::ipc::InvokeResponseBody::Json(json_string) => {
            serde_json::from_str(&json_string).expect("deserialize command response")
        }
        tauri::ipc::InvokeResponseBody::Raw(bytes) => {
            panic!("unexpected raw response: {bytes:?}")
        }
    }
}

#[test]
fn handle_edit_returns_ok_and_updates_document() {
    let _env = TimelineEnvGuard::new();
    let (_app, webview) = build_test_app();

    let payload = json!({
        "payload": {
            "base_version": 0,
            "ops": [
                {"type": "insert", "position": 0, "text": "Hello"}
            ]
        }
    });

    let response = invoke_command(&webview, "handle_edit", payload);
    assert_eq!(response, json!({"status": "ok", "new_version": 1}));

    let document = invoke_command(&webview, "get_full_document", json!({}));
    assert_eq!(document, Value::String("Hello".into()));
}

#[test]
fn handle_edit_returns_conflict_on_version_mismatch() {
    let _env = TimelineEnvGuard::new();
    let (_app, webview) = build_test_app();

    // First, create version 1.
    let payload = json!({
        "payload": {
            "base_version": 0,
            "ops": [
                {"type": "insert", "position": 0, "text": "One"}
            ]
        }
    });
    let response = invoke_command(&webview, "handle_edit", payload);
    assert_eq!(response, json!({"status": "ok", "new_version": 1}));

    // Now send with stale base_version.
    let conflict_payload = json!({
        "payload": {
            "base_version": 0,
            "ops": [
                {"type": "insert", "position": 3, "text": "Two"}
            ]
        }
    });
    let conflict_response = invoke_command(&webview, "handle_edit", conflict_payload);

    assert_eq!(
        conflict_response,
        json!({"status": "conflict", "server_version": 1})
    );
}

#[test]
fn get_log_for_date_returns_entries_for_requested_day() {
    let env_guard = TimelineEnvGuard::new();
    let snapshot = json!({
        "version": 3,
        "blocks": [
            {"date": "2024-12-30", "text": "Day before\n", "tags": []},
            {"date": "2024-12-31", "text": "Morning tasks\n", "tags": []},
            {"date": "2024-12-31", "text": "Evening review\n", "tags": []}
        ]
    });

    fs::write(
        env_guard.path(),
        serde_json::to_string_pretty(&snapshot).unwrap(),
    )
    .expect("write snapshot");

    let (_app, webview) = build_test_app();

    let response = invoke_command(&webview, "get_log_for_date", json!({"date": "2024-12-31"}));

    assert_eq!(
        response,
        Value::String("Morning tasks\nEvening review\n".into())
    );
}

#[test]
fn get_document_snapshot_returns_content_and_version() {
    let env_guard = TimelineEnvGuard::new();
    let snapshot = json!({
        "version": 7,
        "blocks": [
            {"date": "2025-01-01", "text": "Happy New Year!", "tags": []}
        ]
    });

    fs::write(
        env_guard.path(),
        serde_json::to_string_pretty(&snapshot).unwrap(),
    )
    .expect("write snapshot");

    let (_app, webview) = build_test_app();

    let response = invoke_command(&webview, "get_document_snapshot", json!({}));

    assert_eq!(
        response,
        json!({
            "content": "Happy New Year!",
            "version": 7
        })
    );
}

fn write_search_snapshot(path: &PathBuf) {
    let snapshot = json!({
        "version": 1,
        "blocks": [
            {"date": "2024-01-01", "text": "Sightline planning", "tags": [2]},
            {"date": "2024-01-02", "text": "Home improvements", "tags": [3]},
            {"date": "2024-01-03", "text": "Journal entry", "tags": [5]}
        ],
        "tag_registry": [
            {"id": 1, "name": "project", "parent_id": null},
            {"id": 2, "name": "sightline", "parent_id": 1},
            {"id": 3, "name": "home", "parent_id": 1},
            {"id": 4, "name": "type", "parent_id": null},
            {"id": 5, "name": "journal", "parent_id": 4}
        ]
    });

    fs::write(path, serde_json::to_string_pretty(&snapshot).unwrap()).expect("write snapshot");
}

#[test]
fn search_prefix_command_returns_matching_block_ids() {
    let env_guard = TimelineEnvGuard::new();
    write_search_snapshot(env_guard.path());

    let (_app, webview) = build_test_app();
    let response = invoke_command(&webview, "search_prefix", json!({"query": "#project"}));

    assert_eq!(response, json!([0, 1]));
}

#[test]
fn search_infix_command_returns_partial_matches() {
    let env_guard = TimelineEnvGuard::new();
    write_search_snapshot(env_guard.path());

    let (_app, webview) = build_test_app();
    let response = invoke_command(&webview, "search_infix", json!({"query": "sight"}));

    assert_eq!(response, json!([0]));
}

#[test]
fn autocomplete_tag_command_returns_canonical_tags() {
    let env_guard = TimelineEnvGuard::new();
    write_search_snapshot(env_guard.path());

    let (_app, webview) = build_test_app();
    let response = invoke_command(&webview, "autocomplete_tag", json!({"query": "#pro"}));

    #[derive(serde::Deserialize)]
    struct Suggestion {
        name: String,
        #[serde(default)]
        color: Option<String>,
    }

    let tags: Vec<Suggestion> = serde_json::from_value(response).expect("parse tag list");
    let names: Vec<_> = tags
        .iter()
        .map(|suggestion| suggestion.name.as_str())
        .collect();
    assert!(names.contains(&"#project"));
    assert!(names.contains(&"#project:sightline"));
    assert!(names.contains(&"#project:home"));
    assert!(tags.iter().all(|suggestion| suggestion.color.is_some()));
}

#[test]
fn intern_tag_command_creates_and_persists() {
    let env_guard = TimelineEnvGuard::new();

    let (_app, webview) = build_test_app();

    let response = invoke_command(&webview, "intern_tag", json!({"tag": "#focus:deep"}));

    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Descriptor {
        #[allow(dead_code)]
        id: u32,
        name: String,
        color: String,
    }

    let descriptor: Descriptor = serde_json::from_value(response).expect("parse descriptor");
    assert!(descriptor.id >= 1);
    assert_eq!(descriptor.name, "#focus:deep");
    assert!(!descriptor.color.is_empty());

    // Ensure the timeline snapshot persisted the new tag
    let snapshot: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(env_guard.path()).expect("read timeline"))
            .expect("parse snapshot");
    let tag_registry = snapshot
        .get("tag_registry")
        .and_then(|value| value.as_array())
        .expect("tag registry array");
    assert!(tag_registry
        .iter()
        .any(|tag| { tag.get("name").and_then(|name| name.as_str()) == Some("deep") }));
}

#[test]
fn assign_block_tags_command_updates_block() {
    let env_guard = TimelineEnvGuard::new();
    write_search_snapshot(env_guard.path());

    let (_app, webview) = build_test_app();
    let response = invoke_command(
        &webview,
        "assign_block_tags",
        json!({
            "blockIndex": 1,
            "tags": ["#project:home", "type:journal"]
        }),
    );

    #[derive(serde::Deserialize)]
    struct Descriptor {
        #[allow(dead_code)]
        id: u32,
        name: String,
        color: String,
    }

    let descriptors: Vec<Descriptor> = serde_json::from_value(response).expect("descriptor list");
    assert_eq!(descriptors.len(), 2);
    assert!(descriptors.iter().all(|d| d.id > 0));
    assert!(descriptors.iter().all(|d| !d.color.is_empty()));
    assert!(descriptors.iter().any(|d| d.name == "#project:home"));

    let snapshot: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(env_guard.path()).expect("read timeline"))
            .expect("parse snapshot");
    let blocks = snapshot
        .get("blocks")
        .and_then(|value| value.as_array())
        .expect("blocks array");
    let second = blocks.get(1).expect("second block");
    let tags = second
        .get("tags")
        .and_then(|value| value.as_array())
        .expect("block tags");
    assert_eq!(tags.len(), 2);
}

#[test]
fn list_tags_command_returns_descriptors() {
    let env_guard = TimelineEnvGuard::new();
    write_search_snapshot(env_guard.path());

    let (_app, webview) = build_test_app();
    let response = invoke_command(&webview, "list_tags", json!({}));

    #[derive(serde::Deserialize)]
    struct Descriptor {
        #[allow(dead_code)]
        id: u32,
        name: String,
        color: String,
    }

    let descriptors: Vec<Descriptor> = serde_json::from_value(response).expect("descriptor list");
    assert!(!descriptors.is_empty());
    assert!(descriptors.iter().all(|d| d.name.starts_with('#')));
    assert!(descriptors.iter().all(|d| !d.color.is_empty()));
}

#[test]
fn list_blocks_command_returns_ranges() {
    let env_guard = TimelineEnvGuard::new();
    write_search_snapshot(env_guard.path());

    let (_app, webview) = build_test_app();
    let response = invoke_command(&webview, "list_blocks", json!({}));

    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct BlockMetadata {
        #[allow(dead_code)]
        index: u32,
        start_offset: u32,
        end_offset: u32,
        #[allow(dead_code)]
        tags: Vec<u32>,
    }

    let blocks: Vec<BlockMetadata> = serde_json::from_value(response).expect("block list");
    assert!(!blocks.is_empty());
    assert!(blocks
        .windows(2)
        .all(|pair| pair[0].end_offset <= pair[1].start_offset));
}
