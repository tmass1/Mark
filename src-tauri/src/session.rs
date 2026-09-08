use crate::capture::{Capture, Preview};
use serde::Serialize;
use std::sync::{Mutex, Arc, atomic::{AtomicBool, Ordering}};

#[derive(Default)]
pub struct Session {
    pub capture: Option<Capture>,
    pub error: Option<String>,
    pub busy: bool,
    pub previous_pid: Option<i32>,
    pub cancelled: Arc<AtomicBool>,
    pub quitting: bool,
}

#[derive(Clone, Serialize)]
pub struct Snapshot { pub capture: Option<Preview>, pub error: Option<String>, pub busy: bool }

impl Session {
    pub fn begin_capture(&mut self) -> bool {
        if self.busy { return false; }
        self.busy = true; self.error = None;
        self.cancelled.store(false, Ordering::SeqCst);
        true
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot { capture: self.capture.as_ref().map(Capture::preview), error: self.error.clone(), busy: self.busy }
    }
}

pub type State = Mutex<Session>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_shortcuts_cannot_start_parallel_captures() {
        let mut session = Session::default();
        assert!(session.begin_capture());
        assert!(!session.begin_capture());
        session.busy = false;
        assert!(session.begin_capture());
    }
}
