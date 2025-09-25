use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Runtime};
use tracing::error;

const CHAT_MESSAGE_EVENT: &str = "chat-message";
const CHAT_RESPONSE_EVENT: &str = "chat-response";

#[derive(Debug, Deserialize)]
struct ChatMessagePayload {
    text: String,
}

#[derive(Clone, Debug, Serialize)]
struct ChatResponsePayload {
    text: String,
}

pub fn register<R: Runtime>(app: AppHandle<R>) {
    let handle = app.clone();

    app.listen_any(CHAT_MESSAGE_EVENT, move |event| {
        handle_payload(&handle, event.payload());
    });
}

pub fn handle_payload<R: Runtime>(handle: &AppHandle<R>, payload: &str) {
    if payload.is_empty() {
        return;
    }

    let message: ChatMessagePayload = match serde_json::from_str(payload) {
        Ok(message) => message,
        Err(err) => {
            error!(?err, "failed to parse chat-message payload");
            return;
        }
    };

    let response = ChatResponsePayload {
        text: format!("ECHO: {}", message.text),
    };

    if let Err(err) = handle.emit(CHAT_RESPONSE_EVENT, response) {
        error!(?err, "failed to emit chat-response event");
    }
}
