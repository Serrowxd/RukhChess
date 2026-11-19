//! The HTTP side: board files, `/api/hello`, the view socket, the coach routes and MCP, behind one Host/Origin guard.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::watch;

use crate::coach::{routes as coach, Coach};
use crate::hub::Hub;

/// Protocol version shared by `/api/hello` and the WebSocket hello.
pub const PROTO: u32 = 2;

pub struct AppState {
    pub hub: Arc<Hub>,
    pub port: u16,
    pub web_dir: PathBuf,
    /// Numbers views as `view:1`, `view:2`, ...
    pub next_view: AtomicU64,
    /// True while the program is shutting down.
    pub shutdown: watch::Receiver<bool>,
    pub coach: Arc<Coach>,
}

impl AppState {
    pub fn link(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
}

pub fn router(state: Arc<AppState>, mcp: crate::mcp::Service) -> Router {
    Router::new()
        .route("/api/hello", get(hello))
        .route("/api/ws", get(crate::ws::upgrade))
        .route("/api/coach/import/text", post(coach::import_text))
        .route("/api/coach/import/undo", post(coach::undo))
        .route("/api/coach/names", post(coach::names))
        .nest_service("/mcp", mcp)
        .fallback(static_file)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Stops other websites, DNS rebinding included, from reading or driving the board.
async fn guard(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    if allowed(request.headers(), state.port) {
        next.run(request).await
    } else {
        (
            StatusCode::FORBIDDEN,
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            format!(
                "Forbidden: Rukh only answers requests addressed to 127.0.0.1:{0} or localhost:{0}, \
                 from its own pages.\n",
                state.port
            ),
        )
            .into_response()
    }
}

/// One Host and at most one Origin: a repeated header could hide a foreign value.
fn allowed(headers: &HeaderMap, port: u16) -> bool {
    let hosts: Vec<&HeaderValue> = headers.get_all(header::HOST).iter().collect();
    let host_ok = match hosts.as_slice() {
        [host] => match host.to_str() {
            Ok(host) => host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"),
            Err(_) => false,
        },
        _ => false,
    };

    let origins: Vec<&HeaderValue> = headers.get_all(header::ORIGIN).iter().collect();
    let origin_ok = match origins.as_slice() {
        [] => true,
        [origin] => match origin.to_str() {
            Ok(origin) => {
                origin == format!("http://127.0.0.1:{port}")
                    || origin == format!("http://localhost:{port}")
            }
            Err(_) => false,
        },
        _ => false,
    };

    host_ok && origin_ok
}

async fn hello(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "app": "rukh",
        "version": env!("CARGO_PKG_VERSION"),
        "proto": PROTO,
        "instance": state.hub.instance(),
        "port": state.port,
        "link": state.link(),
    }))
}

pub fn not_built_text(web_dir: &Path) -> String {
    format!(
        "Rukh is running, but the 3D board has not been built yet.\n\n\
         Build it once from the Rukh folder:\n\n\
         \x20 cd web\n\
         \x20 npm ci\n\
         \x20 node build.mjs --no-single\n\n\
         Then reload this page. Rukh looks for the built board (index.html) in:\n\
         \x20 {}\n\
         or pass another folder with --web-dir.\n",
        web_dir.display()
    )
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "hdr" => "image/vnd.radiance",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// None when an escape is malformed.
fn percent_decode(raw: &str) -> Option<Vec<u8>> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }

    Some(out)
}

/// Refuses `..`, `.`, empty segments, backslashes, drive letters and NUL.
pub fn safe_relative_path(url_path: &str) -> Option<PathBuf> {
    let decoded = String::from_utf8(percent_decode(url_path)?).ok()?;
    let trimmed = decoded.strip_prefix('/').unwrap_or(&decoded);

    if trimmed.is_empty() {
        return Some(PathBuf::from("index.html"));
    }

    let mut out = PathBuf::new();
    let segments: Vec<&str> = trimmed.split('/').collect();
    for (i, segment) in segments.iter().enumerate() {
        let last = i + 1 == segments.len();

        if segment.is_empty() && last {
            out.push("index.html");
            continue;
        }

        if segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.contains(['\\', ':', '\0'])
        {
            return None;
        }

        out.push(segment);
    }

    Some(out)
}

fn plain(status: StatusCode, text: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        text,
    )
        .into_response()
}

/// When `index.html` is missing, `/` explains how to build the board.
async fn static_file(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let method = request.method();
    if method != Method::GET && method != Method::HEAD {
        return plain(
            StatusCode::METHOD_NOT_ALLOWED,
            "Only GET is supported here.\n".to_string(),
        );
    }

    let url_path = request.uri().path();
    let Some(relative) = safe_relative_path(url_path) else {
        return plain(StatusCode::BAD_REQUEST, format!("Bad path: {url_path}\n"));
    };

    let is_root = url_path == "/";
    let not_found = || plain(StatusCode::NOT_FOUND, format!("Not found: {url_path}\n"));

    let root = match tokio::fs::canonicalize(&state.web_dir).await {
        Ok(root) => root,
        Err(_) if is_root => return plain(StatusCode::OK, not_built_text(&state.web_dir)),
        Err(_) => return not_found(),
    };

    let mut file = root.join(&relative);
    if tokio::fs::metadata(&file)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        file.push("index.html");
    }

    // A symlink in the web folder must not expose files outside it.
    let resolved = match tokio::fs::canonicalize(&file).await {
        Ok(resolved) if resolved.starts_with(&root) => resolved,
        Ok(_) => return not_found(),
        Err(_) if is_root => return plain(StatusCode::OK, not_built_text(&state.web_dir)),
        Err(_) => return not_found(),
    };

    match tokio::fs::read(&resolved).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type(&resolved)),
            )
            .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
            .header(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            )
            .body(Body::from(bytes))
            .unwrap_or_else(|_| not_found()),
        Err(_) => not_found(),
    }
}
