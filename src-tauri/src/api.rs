use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TextOperation {
    Insert {
        position: usize,
        text: String,
    },
    Delete {
        start_position: usize,
        end_position: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditPayload {
    pub base_version: u64,
    pub ops: Vec<TextOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EditResponse {
    Ok { new_version: u64 },
    Conflict { server_version: u64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_response_serializes_to_expected_json() {
        let response = EditResponse::Ok { new_version: 42 };
        let json = serde_json::to_string(&response).expect("serialize response");
        assert_eq!(json, r#"{"status":"ok","new_version":42}"#);
    }
}
