// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

//! Bridge to the `ankiweb.http_*` host imports.
//!
//! `http_send` takes a JSON request description and the raw body, performs the
//! request and returns a handle. The response's JSON metadata and body are then
//! copied out with the remaining calls, after which the handle is released.

use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub timeout_ms: u64,
}

#[derive(Deserialize)]
struct ResponseMeta {
    status: u16,
    url: String,
    headers: Vec<(String, String)>,
}

#[derive(Deserialize)]
pub(crate) struct Failure {
    pub kind: String,
    pub message: String,
}

pub(crate) struct Response {
    pub status: u16,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "ankiweb")]
extern "C" {
    /// Returns a handle; the response is an error if `http_status(handle)` is 0.
    fn http_send(req_ptr: *const u8, req_len: usize, body_ptr: *const u8, body_len: usize) -> u32;
    fn http_meta_len(handle: u32) -> usize;
    fn http_meta(handle: u32, out_ptr: *mut u8);
    fn http_body_len(handle: u32) -> usize;
    fn http_body(handle: u32, out_ptr: *mut u8);
    fn http_free(handle: u32);
}

#[cfg(target_os = "wasi")]
pub(crate) fn send(request: &Request, body: &[u8]) -> Result<Response, Failure> {
    let request = serde_json::to_vec(request).expect("request serializes");
    unsafe {
        let handle = http_send(request.as_ptr(), request.len(), body.as_ptr(), body.len());
        let mut meta = vec![0u8; http_meta_len(handle)];
        http_meta(handle, meta.as_mut_ptr());
        let mut body = vec![0u8; http_body_len(handle)];
        http_body(handle, body.as_mut_ptr());
        http_free(handle);
        parse(&meta, body)
    }
}

#[cfg(not(target_os = "wasi"))]
pub(crate) fn send(_request: &Request, _body: &[u8]) -> Result<Response, Failure> {
    let _ = serde_json::to_vec(_request);
    Err(Failure {
        kind: "connect".into(),
        message: "anki_wasi_http only works on wasm32-wasip1".into(),
    })
}

#[allow(dead_code)]
fn parse(meta: &[u8], body: Vec<u8>) -> Result<Response, Failure> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Meta {
        Ok(ResponseMeta),
        Err { error: Failure },
    }
    match serde_json::from_slice::<Meta>(meta) {
        Ok(Meta::Ok(meta)) => Ok(Response {
            status: meta.status,
            url: meta.url,
            headers: meta.headers,
            body,
        }),
        Ok(Meta::Err { error }) => Err(error),
        Err(e) => Err(Failure {
            kind: "request".into(),
            message: format!("invalid host response: {e}"),
        }),
    }
}
