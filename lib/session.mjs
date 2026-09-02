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
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

let child = null;

export const isOpen = () => !!child;

/**
 * Open the sign-in window. Returns once the browser has been spawned, not once
 * anyone has signed in — that is for the person at the keyboard to decide, and
 * for close() to conclude.
 */
export function open(url) {
  if (child) return { ok: true, already: true };

  const browser = findBrowser();
  if (!browser) {
    return { ok: false, error: 'No Chromium-based browser found. Brave, Edge or Chrome is needed.' };
  }

  mkdirSync(SESSION_DIR, { recursive: true });

  // A separate profile, not the everyday one: this window is the app's, it
  // holds only what is signed into here, and closing it disturbs nothing else.
  const proc = spawn(browser.path, [
    `--user-data-dir=${SESSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Without this a fresh profile opens onto a welcome tour instead of the
    // page that was asked for.
    '--disable-features=ChromeWhatsNewUI',
    url,
  ], { detached: false, stdio: 'ignore', windowsHide: false });

  child = proc;
  proc.on('exit', () => { if (child === proc) child = null; });
  proc.on('error', () => { if (child === proc) child = null; });

  return { ok: true, browser: browser.id, label: browser.label };
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
      const kill = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      // Chromium flushes its cookie store on shutdown; reading a moment too
      // early gets a database mid-write.
      kill.on('exit', () => setTimeout(() => resolve({ ok: true }), 1200));
      kill.on('error', () => { try { proc.kill(); } catch { /* gone */ } resolve({ ok: true }); });
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
