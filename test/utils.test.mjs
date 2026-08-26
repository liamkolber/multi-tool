// Extracts the pure helpers out of utils.js and exercises them, so this tests
// the code that actually ships rather than a copy of it.
import { readFileSync } from 'node:fs';

const src = readFileSync('public/tools/utils.js', 'utf8');

const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${what}`);
  return m[0];
};

const preamble = `
  const enc = new TextEncoder();
  const dec = new TextDecoder();
`;

const sandbox = new Function(`
  ${preamble}
  ${grab(/function toBase64\(text, urlSafe\) \{[\s\S]*?\n\}/, 'toBase64')}
  ${grab(/function fromBase64\(text, urlSafe\) \{[\s\S]*?\n\}/, 'fromBase64')}
  ${grab(/const TX = \{[\s\S]*?\n\};/, 'TX')}
  return { toBase64, fromBase64, TX };
`)();

const { toBase64, fromBase64, TX } = sandbox;

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(32)} ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};

console.log('--- base64 round-trips ---');
const SAMPLES = [
  'hello',
  '',
  'a',
  'ab',
  'abc',
  'Ünïcödé and émojis 🎛️📚🧪',
  '日本語のテキスト',
  'line1\nline2\ttabbed',
  '{"json":true,"n":1.5}',
  '~!@#$%^&*()_+-=[]{}|;:\'",.<>/?`',
];

for (const s of SAMPLES) {
  const label = s.length > 18 ? `${s.slice(0, 18)}…` : (s || '(empty)');
  check(`std  ${label}`, fromBase64(toBase64(s, false), false), s);
  check(`url  ${label}`, fromBase64(toBase64(s, true), true), s);
}

console.log('\n--- base64 shape ---');
check('known value', toBase64('hello', false), 'aGVsbG8=');
check('url-safe drops padding', toBase64('hello', true), 'aGVsbG8');
// '?' + 'à' produces bytes that encode to + and / in standard base64.
const tricky = 'ûÿ¾';
const std = toBase64(tricky, false);
const url = toBase64(tricky, true);
check('std has +/ or =', /[+/=]/.test(std), true);
check('url-safe has none', /[+/=]/.test(url), false);
check('url-safe still decodes', fromBase64(url, true), tricky);

console.log('\n--- text transforms ---');
check('upper', TX.upper('aBc'), 'ABC');
check('lower', TX.lower('aBc'), 'abc');
check('title', TX.title('hello wORLD there'), 'Hello World There');
check('slug', TX.slug('Hello, World! 2024'), 'hello-world-2024');
check('slug trims dashes', TX.slug('  --Hi--  '), 'hi');
check('trim lines', TX.trim('  a  \n  b  '), 'a\nb');
check('squeeze', TX.squeeze('a\n\n\nb\n  \nc'), 'a\nb\nc');
check('dedupe', TX.dedupe('a\nb\na\nc\nb'), 'a\nb\nc');
check('sort', TX.sort('c\na\nb'), 'a\nb\nc');
check('rsort', TX.rsort('a\nc\nb'), 'c\nb\na');
check('reverse', TX.reverse('a\nb\nc'), 'c\nb\na');
check('transforms leave empty alone', TX.dedupe(''), '');

console.log('\n--- transforms never throw ---');
const EDGE = ['', '\n', '\n\n\n', '   ', 'a', '🎛️', 'a\r\nb'];
let threw = null;
for (const [name, fn] of Object.entries(TX)) {
  for (const s of EDGE) {
    try { fn(s); } catch (err) { threw = `${name} on ${JSON.stringify(s)}: ${err.message}`; }
  }
}
check('all transforms survive edge input', threw, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
