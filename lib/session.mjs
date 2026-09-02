// A browser profile the app owns, for sites that only answer a logged-in
// request.
//
// The obvious approach — read cookies straight out of your everyday browser —
// does not work on Windows: a running Chromium keeps its cookie database
// locked, and yt-dlp fails with "Could not copy Chrome cookie database". Both
// Edge and Brave fail that way here. Telling someone to close their browser
// before every download is not a feature.
//
// So the app keeps its own profile directory and launches a browser against
// it. You sign in once, in a real window, on the real site. We close that
// window ourselves, which means the database is never locked when yt-dlp comes
// to read it, and the session persists in the profile for next time.
//
// Nothing is copied out. The cookies stay in the profile; yt-dlp is pointed at
// it with --cookies-from-browser and does its own reading.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, openSync, closeSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Experimental in Node, and used here only to read cookie NAMES out of a copy
// of the store — never to write, and never against the live profile.
import { DatabaseSync } from 'node:sqlite';

import { ROOT } from './core.mjs';

export const SESSION_DIR = join(ROOT, '.browser-session');

// Chromium forks only: they share the --user-data-dir flag and the cookie
// store layout that yt-dlp understands. Firefox uses a different profile
// format and a different flag, and is not worth a second code path here.
const CANDIDATES = [
  { id: 'brave', label: 'Brave', paths: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ] },
  { id: 'edge', label: 'Edge', paths: [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ] },
  { id: 'chrome', label: 'Chrome', paths: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] },
];

export function findBrowser() {
  for (const b of CANDIDATES) {
    const path = b.paths.find((p) => existsSync(p));
    if (path) return { ...b, path };
  }
  return null;
}

// The cookie store only exists once the browser has run at least once.
export const hasProfile = () => existsSync(join(SESSION_DIR, 'Default', 'Network', 'Cookies'));

const COOKIE_DB = () => join(SESSION_DIR, 'Default', 'Network', 'Cookies');

// Whether the browser still holds the profile. While it does, the cookie
// database cannot be opened at all — which is inconvenient for reading it and
// perfect for detecting that the window is still up.
export function profileLocked() {
  if (!hasProfile()) return false;
  try {
    closeSync(openSync(COOKIE_DB(), 'r'));
    return false;
  } catch {
    return true;
  }
}

// Is there an actual login in there?
//
// A profile existing proves nothing: merely opening Instagram's login page
// leaves csrftoken, mid and ig_did behind. sessionid is the one that means
// somebody signed in, and ds_user_id says who. Cookie *values* are encrypted,
// but the names are not, so this can answer the question without decrypting
// anything or caring what the values are.
//
// Readable only while the browser is closed, which is the same moment the
// session becomes usable — so the check and the thing it checks for become
// true together.
export function signedInTo(site = 'instagram') {
  if (!hasProfile() || profileLocked()) return null;

  const host = { instagram: '.instagram.com' }[site] || `.${site}`;
  let db;
  try {
    // Copied first: an experimental reader pointed at a live browser profile
    // is not a risk worth taking with someone's session.
    const tmp = join(tmpdir(), `mt-cookies-${process.pid}.db`);
    copyFileSync(COOKIE_DB(), tmp);
    db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare(
      'SELECT name FROM cookies WHERE host_key = ? AND length(encrypted_value) > 0',
    ).all(host);
    const names = new Set(rows.map((r) => r.name));
    return { signedIn: names.has('sessionid'), cookies: names.size };
  } catch {
    // An unreadable database is not a signed-in one, but it is not a definite
    // no either — say so rather than inventing an answer.
    return null;
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}

let child = null;

// A reference is not proof of life. Chromium's launcher process exits within
// moments of handing off to the real browser, and a stale reference made every
// later attempt short-circuit on "already open" and spawn nothing at all —
// which looked exactly like the window failing to appear.
const alive = (p) => !!p && p.exitCode === null && !p.killed;

export const isOpen = () => alive(child);

/**
 * Open the sign-in window. Returns once the browser has been spawned, not once
 * anyone has signed in — that is for the person at the keyboard to decide, and
 * for close() to conclude.
 */
export async function open(url) {
  if (alive(child)) return { ok: true, already: true, label: findBrowser()?.label || null };

  // Whatever was there is gone; do not let its ghost block a retry.
  child = null;

  const browser = findBrowser();
  if (!browser) {
    return { ok: false, error: 'No Chromium-based browser found. Brave, Edge or Chrome is needed.' };
  }

  mkdirSync(SESSION_DIR, { recursive: true });

  // A separate profile, not the everyday one: this window is the app's, it
  // holds only what is signed into here, and closing it disturbs nothing else.
  //
  // A profile left locked by a browser that did not shut down cleanly will
  // refuse to start again, so the lock goes first. It is only ever this app's
  // own profile directory, never a real one.
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(SESSION_DIR, lock), { force: true }); } catch { /* not there */ }
  }

  // --app opens a chromeless window: no tabs, no address bar, no bookmarks —
  // a login box rather than a second browser. It cannot be avoided altogether
  // (a running Chromium locks its cookie store, so the everyday browser's
  // session is unreadable by anything), but it can at least stop looking like
  // a whole browser has been launched at you.
  const proc = spawn(browser.path, [
    `--user-data-dir=${SESSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--app=${url}`,
    '--window-size=520,760',
  ], { detached: false, stdio: 'ignore', windowsHide: false });

  child = proc;
  let failed = null;
  proc.on('exit', () => { if (child === proc) child = null; });
  proc.on('error', (err) => { failed = err; if (child === proc) child = null; });

  // Spawn failures arrive on the next tick, after a naive implementation has
  // already told the browser everything went fine. Waiting a moment means the
  // answer reflects what actually happened.
  await new Promise((r) => setTimeout(r, 700));
  if (failed) return { ok: false, error: `Could not start ${browser.label}: ${failed.message}` };

  return { ok: true, browser: browser.id, label: browser.label, running: alive(proc) };
}

/**
 * Close the window so the cookie database is unlocked and readable.
 *
 * A Chromium browser is a tree of processes and the one we spawned is only the
 * launcher, so killing it is not enough on its own — the profile is what
 * matters, and every process holding it has to go. Windows gets taskkill /T,
 * which walks the tree.
 */
export function close() {
  return new Promise((resolve) => {
    const proc = child;
    child = null;
    if (!proc) return resolve({ ok: true, already: true });

    if (process.platform === 'win32') {
      // Ask first, insist later.
      //
      // Chromium writes its cookie store on a clean shutdown and holds recent
      // changes in memory until then, so a forced kill throws away whatever
      // has not been flushed. Not theoretical: a completed Instagram sign-in
      // left a profile holding csrftoken, mid and ig_did — everything a mere
      // visit sets — and no sessionid at all, because the login was killed out
      // of memory before it reached disk.
      //
      // CloseMainWindow is the graceful path, and it has to be aimed at the
      // window rather than at the tree. A Chromium browser is eight processes
      // here and exactly one of them owns the window; taskkill /T against the
      // process we spawned reached none of them and timed out every time,
      // while closing that one window releases the database in about a third
      // of a second.
      // Single-quoted, not JSON-quoted. PowerShell has no backslash escape, so
      // JSON.stringify's C:\\Users\\… arrives with the doubles intact, matches
      // no command line, and the close silently does nothing — which is why
      // this timed out from the server while working by hand.
      // One line, and every pipe at the end of what precedes it. Windows
      // PowerShell 5.1 rejects a line that *begins* with a pipe, so the
      // prettier multi-line version was a parse error — which, with output
      // discarded, looked exactly like a close that quietly did nothing.
      const ps = `$d = '${SESSION_DIR.replace(/'/g, "''")}'; `
        + "Get-CimInstance Win32_Process -Filter \"Name='brave.exe' OR Name='msedge.exe' OR Name='chrome.exe'\" | "
        + 'Where-Object { $_.CommandLine -like "*$d*" } | '
        + 'ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | '
        + 'Where-Object { $_.MainWindowHandle -ne 0 } | '
        + 'ForEach-Object { $null = $_.CloseMainWindow() }';

      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        stdio: 'ignore',
      });

      const deadline = Date.now() + 12000;
      const settle = () => setTimeout(() => resolve({ ok: true }), 600);

      // The question is not "has our child exited" — that reference tracks the
      // process we spawned, which in app mode is not necessarily the one
      // holding the profile, and polling it timed out every time even when the
      // browser had gone. The question is whether the cookie database has been
      // released, which is both the thing that matters and directly testable:
      // while any Chromium holds it, opening it throws EBUSY.
      const released = () => {
        try {
          closeSync(openSync(join(SESSION_DIR, 'Default', 'Network', 'Cookies'), 'r'));
          return true;
        } catch {
          return false;
        }
      };

      const poll = () => {
        if (released()) return settle();
        if (Date.now() > deadline) {
          // It would not go quietly. Anything unflushed is lost either way now,
          // and leaving the profile locked is worse.
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          return settle();
        }
        setTimeout(poll, 300);
      };
      poll();
      return;
    }

    try { proc.kill(); } catch { /* already gone */ }
    setTimeout(() => resolve({ ok: true }), 1200);
  });
}

// What yt-dlp needs to read this profile: the browser id plus the directory.
export const cookieSpec = () => {
  const browser = findBrowser();
  return browser && hasProfile() ? `${browser.id}:${SESSION_DIR}` : null;
};
