// Liam's Multi-Tool — the shell.
//
// This file owns the icon rail, the launcher home screen and the hash router.
// It knows nothing about what any tool does: each module in ./tools/ exports a
// `tool` object with an id, a bit of chrome for the launcher, and a mount() that
// fills its own panel. Adding a tool is one import and one array entry.

import { $, closeModal, isModalOpen } from './lib/dom.js';

import { tool as media } from './tools/media.js';
import { tool as downloader } from './tools/downloader.js';
import { tool as convert } from './tools/convert.js';
import { tool as library } from './tools/library.js';
import { tool as utils } from './tools/utils.js';
import { tool as reddit } from './tools/reddit.js';

const TOOLS = [media, downloader, convert, library, utils, reddit];
const byId = new Map(TOOLS.map((t) => [t.id, t]));

const LAST_TOOL_KEY = 'multitool:last';
const mounted = new Set();

const els = {
  rail: $('rail'),
  stage: $('stage'),
  home: $('home'),
  homeGrid: $('home-grid'),
};

// --- Chrome ---

function renderRail() {
  els.rail.innerHTML = `
    <button class="rail-btn rail-home" type="button" data-route="" title="Home" aria-label="Home">
      <span class="rail-icon">🧰</span>
    </button>
    <div class="rail-tools">
      ${TOOLS.map((t) => `
        <button class="rail-btn" type="button" data-route="${t.id}" title="${t.name}" aria-label="${t.name}">
          <span class="rail-icon">${t.icon}</span>
        </button>`).join('')}
    </div>`;
}

function renderHome() {
  els.homeGrid.innerHTML = TOOLS.map((t) => `
    <button class="home-card" type="button" data-route="${t.id}">
      <span class="home-card-icon">${t.icon}</span>
      <span class="home-card-name">${t.name}</span>
      <span class="home-card-blurb">${t.blurb}</span>
    </button>`).join('');
}

// One panel per tool, created empty; the tool fills it on first visit.
function buildPanels() {
  TOOLS.forEach((t) => {
    const panel = document.createElement('section');
    panel.className = 'tool-panel';
    panel.id = `panel-${t.id}`;
    panel.hidden = true;
    els.stage.append(panel);
  });
}

// --- Routing (#/<tool-id>, or #/ for the launcher) ---

function currentRoute() {
  const id = (location.hash || '').replace(/^#\/?/, '');
  return byId.has(id) ? id : '';
}

function show(routeId) {
  const tool = byId.get(routeId) || null;

  els.home.hidden = !!tool;
  TOOLS.forEach((t) => { $(`panel-${t.id}`).hidden = t !== tool; });
  els.rail.querySelectorAll('.rail-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.route === routeId)
  );
  document.title = tool ? `${tool.name} · Liam's Multi-Tool` : "Liam's Multi-Tool";

  if (!tool) return;
  if (!mounted.has(tool.id)) {
    mounted.add(tool.id);
    tool.mount($(`panel-${tool.id}`));
  }
  tool.show?.();
  try { localStorage.setItem(LAST_TOOL_KEY, tool.id); } catch { /* ignore quota */ }
}

function go(routeId) {
  const next = `#/${routeId}`;
  if (location.hash === next) show(routeId);
  else location.hash = next;
}

// --- Init ---

renderRail();
renderHome();
buildPanels();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-route]');
  if (btn) go(btn.dataset.route);
});

window.addEventListener('hashchange', () => show(currentRoute()));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isModalOpen()) closeModal();
});

$('modal').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModal();
});

// A bare URL lands on the launcher; a hash deep-links straight into a tool.
show(currentRoute());
