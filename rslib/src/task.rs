// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

//! Background work that callers can poll or wait on.
//!
//! Native builds run each task on its own thread. WASI builds have no threads,
//! so tasks are queued instead, and run when something waits on them or when
//! the host calls [run_deferred_tasks] between backend requests.

#[cfg(not(target_os = "wasi"))]
pub struct Task<T>(std::thread::JoinHandle<T>);

#[cfg(not(target_os = "wasi"))]
pub fn spawn<T, F>(func: F) -> Task<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    Task(std::thread::spawn(func))
}

#[cfg(not(target_os = "wasi"))]
impl<T> Task<T> {
    pub fn is_finished(&self) -> bool {
        self.0.is_finished()
    }

    pub fn join(self) -> std::thread::Result<T> {
        self.0.join()
    }
}

/// Runs queued tasks until none are left, returning how many ran. A no-op on
/// native builds.
#[cfg(not(target_os = "wasi"))]
pub fn run_deferred_tasks() -> usize {
    0
}

#[cfg(target_os = "wasi")]
pub use deferred::*;

#[cfg(target_os = "wasi")]
mod deferred {
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::Mutex;

    enum State<T> {
        Pending(Box<dyn FnOnce() -> T + Send>),
        Running,
        Done(T),
        Taken,
    }

    trait Runnable: Send + Sync {
        fn run(&self);
    }

    struct Slot<T>(Mutex<State<T>>);

    impl<T: Send> Runnable for Slot<T> {
        fn run(&self) {
            let state = std::mem::replace(&mut *self.0.lock().unwrap(), State::Running);
            match state {
                State::Pending(func) => {
                    // the lock is released while the task runs, so it can be polled
                    let out = func();
                    *self.0.lock().unwrap() = State::Done(out);
                }
                other => *self.0.lock().unwrap() = other,
            }
        }
    }

    static QUEUE: Mutex<VecDeque<Arc<dyn Runnable>>> = Mutex::new(VecDeque::new());

    pub struct Task<T>(Arc<Slot<T>>);

    pub fn spawn<T, F>(func: F) -> Task<T>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let slot = Arc::new(Slot(Mutex::new(State::Pending(Box::new(func)))));
        QUEUE.lock().unwrap().push_back(slot.clone());
        Task(slot)
    }

    impl<T: Send + 'static> Task<T> {
        pub fn is_finished(&self) -> bool {
            matches!(*self.0 .0.lock().unwrap(), State::Done(_) | State::Taken)
        }

        /// Runs the task now if it has not run yet.
        pub fn join(self) -> std::thread::Result<T> {
            self.0.run();
            match std::mem::replace(&mut *self.0 .0.lock().unwrap(), State::Taken) {
                State::Done(out) => Ok(out),
                _ => Err(Box::new("task was already joined or is still running")),
            }
        }
    }

    pub fn run_deferred_tasks() -> usize {
        let mut ran = 0;
        loop {
            let next = QUEUE.lock().unwrap().pop_front();
            match next {
                Some(task) => task.run(),
                None => break ran,
            }
            ran += 1;
        }
    }
}

/// [tokio::io::AsyncWrite] over a std file, for WASI where tokio has no `fs`
/// support. Writes complete immediately, which is fine in a single-threaded
/// host.
#[cfg(target_os = "wasi")]
pub(crate) struct BlockingFile(pub std::fs::File);

#[cfg(target_os = "wasi")]
impl tokio::io::AsyncWrite for BlockingFile {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::task::Poll::Ready(std::io::Write::write(&mut self.0, buf))
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(std::io::Write::flush(&mut self.0))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.poll_flush(cx)
    }
}
