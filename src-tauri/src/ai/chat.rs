//! Chat completions against the local server, streamed to the UI as events:
//! `ai://<id>/token` (text), `ai://<id>/reasoning` (thinking text), `ai://<id>/tool_calls` (the
//! complete calls), `ai://<id>/done` ({finishReason, timings}) and `ai://<id>/error` (AiError).

use super::{server, AiError};
use crate::process::lock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn requests() -> &'static Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    static R: OnceLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub ctx: u32,
    pub messages: Value,
    pub tools: Option<Value>,
    /// A JSON schema the reply must follow (`response_format: json_schema`).
    pub schema: Option<Value>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Done {
    finish_reason: Option<String>,
    /// Generation speed reported by llama-server.
    tokens_per_second: Option<f64>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

#[derive(Default, Clone, Serialize)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

fn auth(req: reqwest::RequestBuilder, ep: &server::Endpoint) -> reqwest::RequestBuilder {
    req.bearer_auth(&ep.key)
}

/// Turns an HTTP error body into a typed error.
fn http_error(status: reqwest::StatusCode, body: &str) -> AiError {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_owned)).unwrap_or_else(|| body.trim().to_owned());
    let lower = message.to_lowercase();
    if lower.contains("context") && (lower.contains("exceed") || lower.contains("too long") || lower.contains("larger than")) {
        AiError::new("CONTEXT_TOO_SMALL", format!("The conversation doesn't fit in the context size. Start a new chat or raise the context size. ({message})"))
    } else {
        AiError::new("SERVER", format!("The AI engine returned {status}: {message}"))
    }
}

async fn stream(app: &AppHandle, id: &str, req: ChatRequest) -> Result<(), AiError> {
    let ep = server::ensure(app, &req.model, req.ctx).await?;
    let mut body = json!({
        "messages": req.messages,
        "stream": true,
        "temperature": req.temperature.unwrap_or(0.2),
        "cache_prompt": true,
        "timings_per_token": false,
    });
    if let Some(max) = req.max_tokens {
        body["max_tokens"] = json!(max);
    }
    if let Some(tools) = req.tools.filter(|t| t.as_array().is_some_and(|a| !a.is_empty())) {
        body["tools"] = tools;
        body["tool_choice"] = json!("auto");
        body["parse_tool_calls"] = json!(true);
    }
    if let Some(schema) = req.schema {
        body["response_format"] = json!({ "type": "json_schema", "json_schema": { "name": "action", "schema": schema, "strict": true } });
    }
    let resp = auth(server::client().post(format!("{}/v1/chat/completions", ep.base)), &ep)
        .json(&body)
        .send()
        .await
        .map_err(|_| server::last_error("The AI engine stopped responding."))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(http_error(status, &text));
    }

    let mut resp = resp;
    let mut buf = String::new();
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut done = Done::default();
    let channel = |name: &str| format!("ai://{id}/{name}");
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(_) => return Err(server::last_error("The AI engine stopped while answering.")),
        };
        server::touch();
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // Server-sent events: `data: {...}` lines separated by blank lines.
        while let Some(end) = buf.find('\n') {
            let line = buf[..end].trim().to_owned();
            buf.drain(..=end);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = v.get("error") {
                return Err(http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": err }).to_string()));
            }
            if let Some(t) = v.get("timings") {
                done.tokens_per_second = t["predicted_per_second"].as_f64();
                done.prompt_tokens = t["prompt_n"].as_u64();
                done.completion_tokens = t["predicted_n"].as_u64();
            }
            let Some(choice) = v["choices"].get(0) else { continue };
            let delta = &choice["delta"];
            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                let _ = app.emit(&channel("token"), text);
            }
            if let Some(text) = delta["reasoning_content"].as_str().filter(|t| !t.is_empty()) {
                let _ = app.emit(&channel("reasoning"), text);
            }
            // Tool calls arrive in pieces keyed by index: the name first, then argument fragments.
            for tc in delta["tool_calls"].as_array().into_iter().flatten() {
                let index = tc["index"].as_u64().unwrap_or(calls.len() as u64) as usize;
                if calls.len() <= index {
                    calls.resize(index + 1, ToolCall::default());
                }
                let call = &mut calls[index];
                if let Some(i) = tc["id"].as_str() {
                    call.id = i.to_owned();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    call.name.push_str(n);
                }
                if let Some(a) = tc["function"]["arguments"].as_str() {
                    call.arguments.push_str(a);
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                done.finish_reason = Some(reason.to_owned());
            }
        }
    }
    let calls: Vec<ToolCall> = calls
        .into_iter()
        .enumerate()
        .filter(|(_, c)| !c.name.is_empty())
        .map(|(i, mut c)| {
            if c.id.is_empty() {
                c.id = format!("call_{i}");
            }
            c
        })
        .collect();
    if !calls.is_empty() {
        let _ = app.emit(&channel("tool_calls"), calls);
    }
    let _ = app.emit(&channel("done"), done);
    Ok(())
}

/// Starts a streamed chat completion; events arrive on `ai://<id>/…`.
#[tauri::command]
pub fn ai_chat(app: AppHandle, id: String, request: ChatRequest) {
    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = stream(&app, &task_id, request).await {
            let _ = app.emit(&format!("ai://{task_id}/error"), e);
        }
        lock(requests()).remove(&task_id);
    });
    lock(requests()).insert(id, handle);
}

/// Stops a chat: dropping the request closes the connection and the server stops generating.
#[tauri::command]
pub fn ai_cancel(app: AppHandle, id: String) {
    if let Some(h) = lock(requests()).remove(&id) {
        h.abort();
        let _ = app.emit(&format!("ai://{id}/done"), Done { finish_reason: Some("cancelled".into()), ..Default::default() });
    }
}

/// Token count of `text` for the running model (for context budgeting).
#[tauri::command]
pub async fn ai_tokenize(app: AppHandle, model: String, ctx: u32, text: String) -> Result<usize, String> {
    let ep = server::ensure(&app, &model, ctx).await?;
    let resp = auth(server::client().post(format!("{}/tokenize", ep.base)), &ep).json(&json!({ "content": text })).send().await.map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["tokens"].as_array().map(|t| t.len()).unwrap_or(0))
}

/// Fill-in-the-middle completion for inline suggestions. Doesn't load a model: returns nothing
/// unless `model` is already running, so typing never triggers a multi-second load.
#[tauri::command]
pub async fn ai_infill(app: AppHandle, model: String, ctx: u32, prefix: String, suffix: String) -> Result<String, String> {
    if server::ai_status().model.as_deref() != Some(model.as_str()) || server::ai_status().status != "ready" {
        return Ok(String::new());
    }
    let ep = server::ensure(&app, &model, ctx).await?;
    let resp = auth(server::client().post(format!("{}/infill", ep.base)), &ep)
        .timeout(Duration::from_secs(10))
        .json(&json!({
            "input_prefix": prefix,
            "input_suffix": suffix,
            "n_predict": 64,
            "temperature": 0.1,
            "top_k": 40,
            "stop": ["\n\n"],
            "cache_prompt": true,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(String::new());
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["content"].as_str().unwrap_or_default().to_owned())
}
