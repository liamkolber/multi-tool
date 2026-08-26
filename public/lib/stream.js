// An event stream that shuts up when nobody is looking.
//
// Every tool that reports progress holds an EventSource open, and the server
// pings each one to keep it alive. Left open on a forgotten tab that is chatter
// forever, for a page nobody is reading. This closes the connection once the
// tab has been hidden for a while with no work in flight, and reopens it — and
// resyncs — when the tab comes back.
//
// It also covers waking from sleep: a suspended machine's sockets are usually
// dead on resume, and the tab is hidden while it sleeps, so the same path that
// handles "you switched tabs" handles "the laptop was shut for an hour".

const IDLE_GRACE_MS = 30_000;

export function idleStream(url, opts = {}) {
  const { onMessage, isBusy = () => false, onWake } = opts;

  let source = null;
  let idleTimer = null;

  function open() {
    if (source) return false;
    try {
      source = new EventSource(url);
    } catch {
      return false;
    }
    source.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onMessage(data);
    };
    // EventSource reconnects on its own; nothing useful to do here.
    source.onerror = () => {};
    return true;
  }

  function close() {
    if (!source) return;
    source.close();
    source = null;
  }

  function onVisibility() {
    clearTimeout(idleTimer);

    if (document.visibilityState === 'visible') {
      // Reopening means we missed whatever happened while away, so the caller
      // gets a chance to refetch rather than trusting stale state.
      const reopened = open();
      if (reopened && onWake) onWake();
      return;
    }

    // Hidden. Work still running keeps the stream — the progress it reports is
    // the reason the connection exists. Otherwise, go quiet.
    idleTimer = setTimeout(() => {
      if (document.visibilityState === 'hidden' && !isBusy()) close();
    }, IDLE_GRACE_MS);
  }

  document.addEventListener('visibilitychange', onVisibility);
  open();

  return {
    open,
    close,
    isOpen: () => !!source,
  };
}
