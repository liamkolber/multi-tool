// Evaluates the Utilities TEMPLATE literal and checks what actually reaches the
// DOM — template literals eat unrecognised escapes, which is how "\d{3}-\w+"
// silently became "d{3}-w+".
import { readFileSync } from 'node:fs';

const src = readFileSync('public/tools/utils.js', 'utf8');
const m = src.match(/const TEMPLATE = `([\s\S]*?)`;\n/);
if (!m) throw new Error('TEMPLATE not found');

const html = new Function(`return \`${m[1]}\`;`)();

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(40)} ${detail}`);
  cond ? pass++ : fail++;
};

console.log('--- backslashes survive into the rendered markup ---');
check('regex placeholder keeps its escapes',
  html.includes('placeholder="\\d{3}-\\w+"'),
  (html.match(/placeholder="[^"]*\{3\}[^"]*"/) || ['(not found)'])[0]);

// Anything that looks like a lost escape: a lone letter where a class belongs.
const suspicious = [...html.matchAll(/placeholder="([^"]*)"/g)]
  .map((x) => x[1])
  .filter((v) => /(?<!\\)\b[dwsWSD]\{\d/.test(v));
check('no other placeholder lost a backslash', suspicious.length === 0, suspicious.join(' | '));

console.log('\n--- structure ---');
const sections = [...html.matchAll(/<section class="ut-sec" data-sec="([a-z]+)"/g)].map((x) => x[1]);
check('six sections present', sections.length === 6, sections.join(', '));
check('none start hidden', !/<section class="ut-sec"[^>]*hidden/.test(html));
check('each has a heading', (html.match(/ut-sec-title/g) || []).length === 6);
check('no tab strip left', !html.includes('ut-tabs'));

const modeCards = [...html.matchAll(/class="ut-card" data-mode="([a-z]+)"( hidden)?/g)];
check('four regex mode cards', modeCards.length === 4, modeCards.map((x) => x[1]).join(', '));
check('exactly one mode card starts visible',
  modeCards.filter((x) => !x[2]).length === 1,
  modeCards.filter((x) => !x[2]).map((x) => x[1]).join(', '));

console.log('\n--- every id the code reaches for exists in the markup ---');
const used = new Set([...src.matchAll(/el\('([^']+)'\)/g)].map((x) => x[1]));
const dynamic = ['rx-g', 'rx-i', 'rx-m', 'rx-s'];
for (const d of dynamic) used.add(d);
const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
const missing = [...used].filter((id) => !declared.has(id));
check(`${used.size} ids all present`, missing.length === 0, missing.join(', '));

console.log('\n--- tags balance ---');
for (const tag of ['section', 'div', 'textarea', 'select', 'ol', 'header']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  check(`<${tag}> balanced`, open === close, `${open} open / ${close} close`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
