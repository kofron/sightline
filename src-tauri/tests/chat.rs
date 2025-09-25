use std::sync::mpsc;
use std::time::Duration;

use sightline_lib::{chat, commands, AppState};
use tauri::{Listener, Manager};

fn build_test_app() -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    tauri::test::mock_builder()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::entry_count,
            commands::handle_edit,
            commands::get_full_document,
            commands::get_document_snapshot,
            commands::get_log_for_date
        ])
        .setup(|app| {
            chat::register(app.handle().clone());
            Ok(())
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .and_then(|app| {
            let webview =
                tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build()?;
            Ok((app, webview))
        })
        .expect("failed to build app")
}

#[test]
fn chat_listener_emits_echo_response() {
    let (_app, webview) = build_test_app();
    let handle = webview.app_handle();
    let (tx, rx) = mpsc::channel::<String>();

    let _listener = handle.listen_any("chat-response", move |event| {
        tx.send(event.payload().to_string()).unwrap();
    });

    chat::handle_payload(handle, r#"{"text":"Hello"}"#);

    let response_json = rx
        .recv_timeout(Duration::from_millis(100))
        .expect("receive chat response");

    let value: serde_json::Value = serde_json::from_str(&response_json).expect("parse response");
    assert_eq!(value["text"], "ECHO: Hello");
}
