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
            commands::get_log_for_date
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
        "entries": [
            {"date": "2024-12-30", "text": "Day before\n"},
            {"date": "2024-12-31", "text": "Morning tasks\n"},
            {"date": "2024-12-31", "text": "Evening review\n"}
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
        "entries": [
            {"date": "2025-01-01", "text": "Happy New Year!"}
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
