use crate::capture::{Capture, Preview};
use serde::Serialize;
use std::sync::{Mutex, Arc, atomic::{AtomicBool, Ordering}, mpsc::Sender};

#[derive(Default)]
pub struct Session {
    pub capture: Option<Capture>,
    pub error: Option<String>,
    pub busy: bool,
    pub previous_pid: Option<i32>,
    pub cancelled: Arc<AtomicBool>,
    pub quitting: bool,
    /// Cancelling a selection puts the editor back only if it was there before.
    pub editor_was_visible: bool,
    /// True only while screencapture is actually running, which is the one state
    /// that has to survive a quit request.
    pub capturing: bool,
    /// Holds the file behind the share sheet alive. The sheet is asynchronous
    /// and the receiving app reads the URL long after the command returns, so
    /// the directory is dropped only when the next share replaces it.
    pub share_dir: Option<tempfile::TempDir>,
    /// An AI tool's ask for a screenshot, while one is waiting. One at a time.
    pub request: Option<Request>,
    next_request: u64,
    /// What the floating thumbnail shows, kept apart from the editor's
    /// capture: whatever empties the editor leaves the thumbnail whole.
    pub thumb: Option<Thumb>,
    next_thumb: u64,
    /// The file the last drag of a thumbnail made. The app it was dropped on
    /// reads it after the drop, so it stays until the next drag replaces it.
    pub drag_dir: Option<tempfile::TempDir>,
}

/// A capture floating in the corner. Numbered, so a click or a drag meant for
/// one that has since gone acts on nothing.
pub struct Thumb { pub id: u64, pub png: Vec<u8>, pub width: u32, pub height: u32 }

/// What an AI tool asked to see, and where its answer goes. The answer is sent
/// once: whichever of Send, Don't Send, the editor closing or the tool giving up
/// comes first takes the request, and the rest find nothing to act on.
pub struct Request {
    pub id: u64,
    /// Who asked and what for, already cleaned for showing.
    pub client: String,
    pub prompt: String,
    /// region, window or display: which way in the editor offers first.
    pub mode: String,
    /// When the tool stops waiting, in milliseconds since 1970, for a tool
    /// known to give up: the editor counts down to it.
    pub deadline: Option<u64>,
    /// The app that asked, to go back to once the screenshot is sent.
    pub return_to: Option<i32>,
    reply: Sender<Reply>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    Sent { png: String, text: String },
    Declined,
    Failed(String),
}

/// The request as the editor sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Asked { pub id: u64, pub client: String, pub prompt: String, pub mode: String, pub deadline: Option<u64> }

#[derive(Clone, Serialize)]
pub struct Snapshot { pub capture: Option<Preview>, pub error: Option<String>, pub busy: bool, pub request: Option<Asked> }

impl Session {
    pub fn begin_capture(&mut self) -> bool {
        if self.busy { return false; }
        self.busy = true; self.error = None;
        self.cancelled.store(false, Ordering::SeqCst);
        true
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            capture: self.capture.as_ref().map(Capture::preview), error: self.error.clone(), busy: self.busy,
            request: self.request.as_ref().map(|r| Asked {
                id: r.id, client: r.client.clone(), prompt: r.prompt.clone(), mode: r.mode.clone(), deadline: r.deadline,
            }),
        }
    }

    /// A new thumbnail, in place of any before it. Returns its number.
    pub fn show_thumb(&mut self, png: Vec<u8>, width: u32, height: u32) -> u64 {
        self.next_thumb += 1;
        self.thumb = Some(Thumb { id: self.next_thumb, png, width, height });
        self.next_thumb
    }

    /// The thumbnail with this number, taken down. An older one's number takes nothing.
    pub fn take_thumb(&mut self, id: u64) -> bool { self.thumb.take_if(|thumb| thumb.id == id).is_some() }

    /// Take an ask, unless one is already waiting: a second would have nowhere
    /// to be shown that did not hide the first.
    pub fn ask(&mut self, client: String, prompt: String, mode: String, deadline: Option<u64>, reply: Sender<Reply>) -> Result<u64, String> {
        if let Some(waiting) = &self.request {
            return Err(format!("Mark is already waiting on a screenshot for {}. Try again once that one is sent or declined.", waiting.client));
        }
        self.next_request += 1;
        self.request = Some(Request { id: self.next_request, client, prompt, mode, deadline, return_to: None, reply });
        Ok(self.next_request)
    }

    /// Answer the ask with this id, and say where its tool's window was. An id
    /// that is not the one waiting -- answered, withdrawn, or replaced since --
    /// answers nothing.
    pub fn answer(&mut self, id: u64, reply: Reply) -> Result<Option<i32>, String> {
        let Some(request) = self.request.take_if(|r| r.id == id) else {
            return Err("That request has ended, so nothing was sent.".into());
        };
        // The tool may have gone in the meantime; then there is no one to tell.
        let _ = request.reply.send(reply);
        Ok(request.return_to)
    }

    /// Whatever is waiting, answered: the editor closing declines it, and Mark
    /// quitting fails it.
    pub fn end_request(&mut self, reply: Reply) -> bool {
        let Some(request) = self.request.take() else { return false };
        let _ = request.reply.send(reply);
        true
    }

    /// The tool stopped waiting. Dropping the request drops its sender, which is
    /// what tells the connection there is nothing more to wait for.
    pub fn withdraw(&mut self, id: u64) -> Option<String> {
        self.request.take_if(|r| r.id == id).map(|request| request.client)
    }
}

pub type State = Mutex<Session>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn repeated_shortcuts_cannot_start_parallel_captures() {
        let mut session = Session::default();
        assert!(session.begin_capture());
        assert!(!session.begin_capture());
        session.busy = false;
        assert!(session.begin_capture());
    }

    fn asked(session: &mut Session) -> (u64, std::sync::mpsc::Receiver<Reply>) {
        let (tx, rx) = channel();
        (session.ask("Claude Code".into(), "the error".into(), "region".into(), None, tx).unwrap(), rx)
    }

    #[test]
    fn one_ask_waits_at_a_time_and_the_editor_is_told_of_it() {
        let mut session = Session::default();
        let (id, _rx) = asked(&mut session);
        assert_eq!(session.snapshot().request,
                   Some(Asked { id, client: "Claude Code".into(), prompt: "the error".into(), mode: "region".into(), deadline: None }));
        let (tx, _) = channel();
        let second = session.ask("Cursor".into(), "the page".into(), "window".into(), Some(1_000), tx);
        assert!(second.unwrap_err().contains("Claude Code"));
    }

    #[test]
    fn an_answer_goes_to_the_ask_it_was_meant_for_and_only_once() {
        let mut session = Session::default();
        let (first, rx) = asked(&mut session);
        session.request.as_mut().unwrap().return_to = Some(42);
        // Withdrawn: a Send that was meant for it lands on nothing.
        assert_eq!(session.withdraw(first), Some("Claude Code".into()));
        assert!(rx.recv().is_err(), "the sender went with the request");
        let (second, rx) = asked(&mut session);
        assert_ne!(first, second);
        assert!(session.answer(first, Reply::Declined).is_err());
        assert_eq!(session.withdraw(first), None);
        // The one that is waiting takes its answer, once.
        let sent = Reply::Sent { png: "AAAA".into(), text: "1. this".into() };
        assert_eq!(session.answer(second, sent.clone()), Ok(None));
        assert_eq!(rx.recv(), Ok(sent));
        assert!(session.answer(second, Reply::Declined).is_err());
        assert_eq!(session.snapshot().request, None);
    }

    #[test]
    fn a_thumbnail_is_acted_on_only_by_its_own_number() {
        let mut session = Session::default();
        let first = session.show_thumb(vec![1], 10, 10);
        let second = session.show_thumb(vec![2], 10, 10);
        assert!(!session.take_thumb(first), "replaced, so a click on the first finds nothing");
        assert!(session.take_thumb(second));
        assert!(session.thumb.is_none() && !session.take_thumb(second));
    }

    #[test]
    fn closing_or_quitting_answers_whatever_is_waiting() {
        let mut session = Session::default();
        assert!(!session.end_request(Reply::Declined));
        let (_, rx) = asked(&mut session);
        assert!(session.end_request(Reply::Failed("Mark quit.".into())));
        assert_eq!(rx.recv(), Ok(Reply::Failed("Mark quit.".into())));
        assert!(session.request.is_none());
    }
}
