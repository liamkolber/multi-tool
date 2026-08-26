// Cross-cutting CSS invariants that only break once someone edits the markup.
//
// The bug this exists for: `.lb-bar input { flex: 1; min-width: 220px }` was
// written when the bar held one text field. Adding an "Include images" checkbox
// later handed the checkbox a 220px minimum and a flex grow, so it floated half
// a bar away from its own label. The CSS was never wrong until the markup moved.
import { readFileSync, readdirSync } from 'node:fs';

const cssFiles = readdirSync('public/styles').map((f) => `public/styles/${f}`);
const jsFiles = ['public/app.js', ...readdirSync('public/tools').map((f) => `public/tools/${f}`)];
const markup = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
  cond ? pass++ : fail++;
};

// Layout properties that make no sense on a checkbox or radio.
const LAYOUT = /(^|;)\s*(flex|min-width)\s*:/;

// Does a container with this class hold a checkbox or radio anywhere inside it?
// Crude span-scan rather than a parser: enough to catch the real case, and a
// false positive here is a rule worth type-scoping anyway.
function containerHasToggle(cls) {
  const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`, 'g');
  for (const m of markup.matchAll(re)) {
    const span = markup.slice(m.index, m.index + 900);
    // Stop at the next container of the same kind so we don't run past it.
    const end = span.indexOf(`class="${cls}`, 10);
    const scope = end > 0 ? span.slice(0, end) : span;
    if (/type="(checkbox|radio)"/.test(scope)) return true;
  }
  return false;
}

const offenders = [];
for (const file of cssFiles) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!LAYOUT.test(rule[2])) continue;
    for (const sel of rule[1].split(',')) {
      const t = sel.trim();
      // A selector ending in a bare `input` matches every input type there is.
      const m = t.match(/^\.([a-zA-Z0-9_-]+)\s+input$/);
      if (!m) continue;
      if (containerHasToggle(m[1])) {
        offenders.push(`${file.split('/').pop()}: "${t}" — .${m[1]} contains a checkbox/radio`);
      }
    }
  }
}

console.log('--- bare `input` selectors that also catch checkboxes ---');
check('no layout rule targets every input in a container with a toggle',
  offenders.length === 0, offenders.join('\n      '));

// Every class the markup hides must survive the base.css override, which is the
// other rule that keeps quietly getting relearned.
console.log('\n--- hiding still works globally ---');
const base = readFileSync('public/styles/base.css', 'utf8');
check('base.css forces [hidden] to win',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(base));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
