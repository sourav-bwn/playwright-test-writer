// Live view: streams REAL frames from the browser that is executing an
// approved test back to this server, so the page can show that browser's
// actual screen while it navigates, types and clicks. Not a replay, not an
// animation: every frame is captured by Chromium's own screencast during
// the run that decides pass/fail.
//
// The generated test calls startLiveStream(page) before acting. When
// LIVE_FRAME_URL is not set (local dev without a server, unit tests) this is
// a complete no-op and the test runs exactly as before.

export async function startLiveStream(page) {
  const target = process.env.LIVE_FRAME_URL;
  if (!target) return null;

  let client;
  try {
    // CDP screencast exists on Chromium only; anything else just runs without
    // the live view (the test itself is unaffected).
    client = await page.context().newCDPSession(page);
  } catch {
    return null;
  }

  let stopped = false;
  let inFlight = false;

  const postFrame = (body) =>
    fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // The live view is best-effort: a dropped frame must never fail a run.
    });

  client.on('Page.screencastFrame', (ev) => {
    // Chromium keeps sending frames only if each one is acknowledged.
    client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    if (stopped || inFlight) return; // drop frames while one is in transit
    inFlight = true;
    let pageUrl = '';
    try {
      pageUrl = page.url();
    } catch {}
    postFrame({ data: ev.data, url: pageUrl }).finally(() => {
      inFlight = false;
    });
  });

  try {
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 55,
      maxWidth: 960,
      maxHeight: 600,
      everyNthFrame: 1,
    });
  } catch {
    return null;
  }

  return async () => {
    stopped = true;
    try {
      await client.send('Page.stopScreencast');
    } catch {}
  };
}

// Per-action reporting: the generated test calls reportAction(index, status)
// around every real browser action, so the workspace can show WHICH step is
// acting right now, not just raw frames. When LIVE_ACTION_URL is not set
// (local dev, unit tests) this is a complete no-op. A dropped report must
// never fail a run, so every error is swallowed.
// Evidence reporting: the generated test captures the page's real aria
// snapshot at the end of the run and posts it here. Same rules as
// reportAction: no-op off-server, never fails a run.
export async function reportEvidence(kind, text) {
  const target = process.env.LIVE_EVIDENCE_URL;
  if (!target) return;
  try {
    await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text: String(text).slice(0, 8000), at: new Date().toISOString() }),
    });
  } catch {
    // best-effort only
  }
}

export async function reportAction(index, status) {
  const target = process.env.LIVE_ACTION_URL;
  if (!target) return;
  try {
    await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, status, at: new Date().toISOString() }),
    });
  } catch {
    // best-effort only
  }
}
