//! What goes out to one socket: a bounded queue drained by a writer task of
//! its own, so a fan-out never waits on a client. A client that falls a
//! whole queue behind is disconnected (1013, "try again later"); it
//! reconnects and replays what it missed from its cursor.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use futures_util::SinkExt;
use futures_util::stream::SplitSink;
use tokio::sync::{Notify, mpsc};

/// Close code for a client too slow to keep up.
pub(crate) const SLOW_CLIENT: u16 = 1013;

/// A close requested from outside the writer; the first one wins.
#[derive(Default)]
struct CloseRequest {
    frame: Mutex<Option<(u16, String)>>,
    notify: Notify,
}

/// The sending side of one socket.
#[derive(Clone)]
pub(crate) struct Outbox {
    queue: mpsc::Sender<Utf8Bytes>,
    close: Arc<CloseRequest>,
}

impl Outbox {
    /// A queue of `capacity` messages and the writer that drains it into
    /// `sink`, one write at a time, each within `write_timeout`.
    pub(crate) fn start(
        sink: SplitSink<WebSocket, Message>,
        capacity: usize,
        write_timeout: Duration,
    ) -> (Self, tokio::task::JoinHandle<()>) {
        let (queue, receiver) = mpsc::channel(capacity.max(1));
        let close = Arc::new(CloseRequest::default());
        let writer = tokio::spawn(write(sink, receiver, Arc::clone(&close), write_timeout));
        (Self { queue, close }, writer)
    }

    /// Queue `text`. A full queue disconnects the client; false when the
    /// message was not queued.
    pub(crate) fn send(&self, text: Utf8Bytes) -> bool {
        match self.queue.try_send(text) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close(SLOW_CLIENT, "slow consumer");
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// Queue a message built here (an ack, an error).
    pub(crate) fn text(&self, text: impl Into<String>) -> bool {
        self.send(Utf8Bytes::from(text.into()))
    }

    /// Close the socket with `code`, ahead of anything still queued.
    pub(crate) fn close(&self, code: u16, reason: &str) {
        let mut frame = self
            .close
            .frame
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if frame.is_none() {
            *frame = Some((code, reason.to_owned()));
            self.close.notify.notify_one();
        }
    }
}

async fn write(
    mut sink: SplitSink<WebSocket, Message>,
    mut receiver: mpsc::Receiver<Utf8Bytes>,
    close: Arc<CloseRequest>,
    write_timeout: Duration,
) {
    loop {
        tokio::select! {
            biased;
            () = close.notify.notified() => {
                let frame = close.frame.lock().unwrap_or_else(PoisonError::into_inner).take();
                if let Some((code, reason)) = frame {
                    let message = Message::Close(Some(CloseFrame {
                        code,
                        reason: Utf8Bytes::from(reason),
                    }));
                    let _ = tokio::time::timeout(write_timeout, sink.send(message)).await;
                }
                break;
            }
            next = receiver.recv() => {
                let Some(text) = next else { break };
                match tokio::time::timeout(write_timeout, sink.send(Message::Text(text))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break,
                    Err(_) => {
                        tracing::debug!("realtime: a write timed out; dropping the client");
                        break;
                    }
                }
            }
        }
    }
    let _ = tokio::time::timeout(write_timeout, sink.close()).await;
}
