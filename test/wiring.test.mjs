// Identifiers a tool uses but never declares.
//
// `node --check` only proves a file parses. Both of these parsed fine and broke
// at runtime: public/tools/downloader.js called fmtNumber() without importing
// it, and an edit to convert.js replaced `const cvJobs = new Map()` instead of
// inserting beside it, leaving five call sites pointing at nothing.
//
// Scoped to each tool's own prefix (cv*, lb*, dl*, rx*, ut*, md*), which is
// where this kind of mistake lands and keeps false positives at zero.
import { readFileSync, readdirSync } from 'node:fs';

const files = [
  'public/app.js',
  ...readdirSync('public/tools').map((f) => `public/tools/${f}`),
  ...readdirSync('public/lib').map((f) => `public/lib/${f}`),
];

const PREFIXES = ['cv', 'lb', 'dl', 'rx', 'ut', 'md', 'rd', 'js', 'en', 'hs', 'tm', 'tx'];
const PREFIXED = new RegExp(`\\b((?:${PREFIXES.join('|')})[A-Z][A-Za-z0-9_$]*)`, 'g');

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(44)} ${detail}`);
  cond ? pass++ : fail++;
};

function declaredIn(src) {
  const names = new Set();
  // const/let/var/function/class, including destructured imports.
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  // Object shorthand keys in the element cache: `sheet: $('lb-sheet')` is not a
  // declaration, but `lb.sheet` is not a bare identifier either, so no clash.
  return names;
}

const problems = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const declared = declaredIn(src);
  const used = new Set();

  // Strip strings and comments so a name inside a template or a comment does
  // not count as a use.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');

  for (const m of code.matchAll(PREFIXED)) used.add(m[1]);

  for (const name of used) {
    // Property access (lb.sheet, cv.path) is not a bare identifier.
    if (new RegExp(`\\.\\s*${name}\\b`).test(code) && !new RegExp(`(?<![.\\w])${name}\\b`).test(code)) continue;
    if (!declared.has(name)) problems.push(`${file.split('/').pop()}: ${name}`);
  }
}

console.log('--- identifiers used but never declared ---');
check('every prefixed identifier is declared where it is used',
  problems.length === 0, problems.join('\n      '));

// dom.js is shared, so a tool using one of its helpers must import it. This is
// the exact shape of the fmtNumber bug.
console.log('\n--- shared helpers are imported before use ---');
const domSrc = readFileSync('public/lib/dom.js', 'utf8');
const domExports = [...domSrc.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]);

const missing = [];
for (const file of files) {
  if (file.endsWith('dom.js')) continue;
  const src = readFileSync(file, 'utf8');
  const imp = src.match(/import \{([^}]+)\} from '[^']*dom\.js'/);
  const imported = new Set(imp ? imp[1].split(',').map((s) => s.trim()) : []);

  for (const name of domExports) {
    if (imported.has(name)) continue;
    const used = new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(src);
    const local = new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(src);
    if (used && !local) missing.push(`${file.split('/').pop()}: ${name}()`);
  }
}
check(`all ${domExports.length} dom.js helpers imported where used`,
  missing.length === 0, missing.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
