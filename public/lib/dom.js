// Helpers every tool leans on: element lookup, escaping, formatting, and the
// one shared modal that lives in the shell.

export const $ = (id) => document.getElementById(id);

export function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fmtNumber(n) {
  return Number(n || 0).toLocaleString();
}

// An <option> element, for appending into a <select> or <optgroup>.
export function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

// The same thing as markup, for building a whole <select> in one innerHTML.
export function optionHtml(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

// --- Shared modal (markup lives in the shell, so any tool can use it) ---

export function showModal(html) {
  const modal = $('modal');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  $('modal-body').innerHTML = html;
}

export function closeModal() {
  const modal = $('modal');
  modal.hidden = true;
  document.body.style.overflow = '';
  $('modal-body').innerHTML = '';
}

export function isModalOpen() {
  return !$('modal').hidden;
}
