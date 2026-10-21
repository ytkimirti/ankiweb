// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

//! C ABI over [anki::backend::Backend] for the web worker that hosts this
//! module (see web/src/lib/engine).
//!
//! Calls are synchronous. Results are left in a buffer owned by this module;
//! the host copies them out with [anki_result_ptr]/[anki_result_len] before
//! making the next call. Every function runs on the worker's only thread.

use std::cell::RefCell;

use anki::backend::init_backend;
use anki::backend::Backend;
use anki::services::BackendCollectionService;
use prost::Message;

thread_local! {
    static BACKEND: RefCell<Option<Backend>> = const { RefCell::new(None) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "ankiweb")]
extern "C" {
    /// Receives an encoded anki.collection.Progress. Returns 1 to request an
    /// abort.
    fn progress(ptr: *const u8, len: usize) -> u32;
}

#[cfg(not(target_os = "wasi"))]
unsafe fn progress(_ptr: *const u8, _len: usize) -> u32 {
    0
}

fn set_result(data: Vec<u8>) {
    RESULT.with(|r| *r.borrow_mut() = data);
}

fn backend() -> Option<Backend> {
    BACKEND.with(|b| b.borrow().clone())
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Allocates `len` bytes for the host to write an input into.
#[no_mangle]
pub extern "C" fn anki_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Frees a buffer from [anki_alloc].
///
/// # Safety
/// `ptr` and `len` must come from a single [anki_alloc] call.
#[no_mangle]
pub unsafe extern "C" fn anki_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn anki_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn anki_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

/// Takes an encoded anki.backend.BackendInit. Returns 0 on success; on failure
/// the result buffer holds a UTF-8 message.
///
/// # Safety
/// `ptr`/`len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn anki_init(ptr: *const u8, len: usize) -> u32 {
    match init_backend(input(ptr, len)) {
        Ok(new_backend) => {
            BACKEND.with(|b| *b.borrow_mut() = Some(new_backend));
            anki::set_progress_hook(|| {
                let Some(backend) = backend() else {
                    return false;
                };
                let Ok(latest) = backend.latest_progress() else {
                    return false;
                };
                let bytes = latest.encode_to_vec();
                unsafe { progress(bytes.as_ptr(), bytes.len()) != 0 }
            });
            set_result(vec![]);
            0
        }
        Err(e) => {
            set_result(e.into_bytes());
            1
        }
    }
}

/// Runs a backend method. Returns 0 if the result buffer holds the encoded
/// output, or 1 if it holds an encoded anki.backend.BackendError.
///
/// # Safety
/// `ptr`/`len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn anki_command(service: u32, method: u32, ptr: *const u8, len: usize) -> u32 {
    let Some(backend) = backend() else {
        set_result(b"backend not initialized".to_vec());
        return 2;
    };
    let (code, out) = match backend.run_service_method(service, method, input(ptr, len)) {
        Ok(out) => (0, out),
        Err(err) => (1, err),
    };
    set_result(out);
    code
}

/// Runs a JSON DB command (see rslib/src/backend/dbproxy.rs). Returns codes
/// like [anki_command].
///
/// # Safety
/// `ptr`/`len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn anki_db_command(ptr: *const u8, len: usize) -> u32 {
    let Some(backend) = backend() else {
        set_result(b"backend not initialized".to_vec());
        return 2;
    };
    let (code, out) = match backend.run_db_command_bytes(input(ptr, len)) {
        Ok(out) => (0, out),
        Err(err) => (1, err),
    };
    set_result(out);
    code
}

/// Runs background work (media sync, backups) queued by earlier calls, and
/// returns how many tasks ran. The host calls this when it has no requests
/// waiting.
#[no_mangle]
pub extern "C" fn anki_run_deferred() -> u32 {
    anki::task::run_deferred_tasks() as u32
}

#[no_mangle]
pub extern "C" fn anki_buildhash_ptr() -> *const u8 {
    anki::version::buildhash().as_ptr()
}

#[no_mangle]
pub extern "C" fn anki_buildhash_len() -> usize {
    anki::version::buildhash().len()
}
