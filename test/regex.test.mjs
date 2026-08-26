import { buildPattern, inferPattern, explainPattern, escapeLiteral } from '../public/lib/regex.js';

let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${JSON.stringify(actual)}${ok ? '' : `  expected ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const truthy = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  cond ? pass++ : fail++;
};

console.log('--- buildPattern ---');
check('single digit', buildPattern([{ kind: 'digit' }]), '\\d');
check('3 digits', buildPattern([{ kind: 'digit', quant: 'exactly', min: 3 }]), '\\d{3}');
check('2-4 letters', buildPattern([{ kind: 'letter', quant: 'between', min: 2, max: 4 }]), '[A-Za-z]{2,4}');
check('one or more word', buildPattern([{ kind: 'word', quant: 'many' }]), '\\w+');
// A multi-character literal must be wrapped before a quantifier, or only the
// last character repeats.
check('literal + quantifier wraps', buildPattern([{ kind: 'literal', value: 'abc', quant: 'many' }]), '(?:abc)+');
check('single-char literal no wrap', buildPattern([{ kind: 'literal', value: 'a', quant: 'many' }]), 'a+');
check('literal is escaped', buildPattern([{ kind: 'literal', value: 'a.b' }]), 'a\\.b');
check('set', buildPattern([{ kind: 'set', value: 'abc', quant: 'many' }]), '[abc]+');
check('negated set', buildPattern([{ kind: 'notset', value: 'xy' }]), '[^xy]');
check('one of', buildPattern([{ kind: 'oneof', value: 'cat|dog' }]), '(?:cat|dog)');
check('capture group', buildPattern([{ kind: 'digit', quant: 'many', group: 'capture' }]), '(\\d+)');
check('named group', buildPattern([{ kind: 'digit', quant: 'many', group: 'named', name: 'id' }]), '(?<id>\\d+)');
check('anchors ignore quantifier', buildPattern([{ kind: 'start', quant: 'many' }]), '^');
check('sequence', buildPattern([
  { kind: 'start' },
  { kind: 'letter', quant: 'exactly', min: 2 },
  { kind: 'literal', value: '-' },
  { kind: 'digit', quant: 'many', group: 'capture' },
  { kind: 'end' },
]), '^[A-Za-z]{2}-(\\d+)$');

console.log('\n--- buildPattern output compiles and matches ---');
const built = buildPattern([
  { kind: 'start' }, { kind: 'letter', quant: 'exactly', min: 2 },
  { kind: 'literal', value: '-' }, { kind: 'digit', quant: 'exactly', min: 4 }, { kind: 'end' },
]);
truthy('AB-1234 matches', new RegExp(built).test('AB-1234'), built);
truthy('A-1234 does not', !new RegExp(built).test('A-1234'), built);
truthy('wrapped literal repeats whole', new RegExp(`^${buildPattern([{ kind: 'literal', value: 'ab', quant: 'many' }])}$`).test('abab'));

console.log('\n--- inferPattern ---');
const idCase = inferPattern(['AB-1234', 'XY-5678', 'QQ-0001']);
check('fixed-width ids', idCase.pattern, '^[A-Z]{2}-\\d{4}$');
truthy('  matches its examples', ['AB-1234', 'XY-5678', 'QQ-0001'].every((s) => new RegExp(idCase.pattern).test(s)));
truthy('  rejects a wrong shape', !new RegExp(idCase.pattern).test('ABC-1234'));

check('varying digit run', inferPattern(['item1', 'item22', 'item333']).pattern, '^[a-z]{4}\\d{1,3}$');
check('dates', inferPattern(['2024-01-05', '1999-12-31']).pattern, '^\\d{4}-\\d{2}-\\d{2}$');
check('mixed case merges', inferPattern(['Ab1', 'cD2']).pattern, '^[A-Za-z]{2}\\d$');

const emails = inferPattern(['ab@x.com', 'cde@yz.com']);
truthy('emails match their examples',
  ['ab@x.com', 'cde@yz.com'].every((s) => new RegExp(emails.pattern).test(s)), emails.pattern);

const unlike = inferPattern(['hello', 'a-1-b-2']);
truthy('unlike shapes fall back to literals', unlike.pattern.includes('|') && !!unlike.note, unlike.pattern);
truthy('  still matches both', ['hello', 'a-1-b-2'].every((s) => new RegExp(unlike.pattern).test(s)));
check('empty input', inferPattern([]).pattern, '');

console.log('\n--- every inferred pattern is a valid regex ---');
truthy('no inferred pattern throws', (() => {
  const sets = [
    ['a', 'b'], ['1'], ['a b', 'c d'], ['x[1]', 'y[2]'], ['a.b', 'c.d'],
    ['(1)', '(2)'], ['a\\b', 'c\\d'], ['^x$', '^y$'], ['   ', 'a'],
  ];
  for (const s of sets) {
    const { pattern } = inferPattern(s);
    if (!pattern) continue;
    try { new RegExp(pattern); } catch { console.log('    threw on', JSON.stringify(s), '->', pattern); return false; }
  }
  return true;
})());

console.log('\n--- explainPattern ---');
const ex1 = explainPattern('^\\d{3}-[A-Z]+$');
console.log(ex1.map((l) => `      ${l}`).join('\n'));
truthy('explains anchors and counts',
  ex1[0].includes('start of the line')
  && ex1[1].includes('digit') && ex1[1].includes('exactly 3')
  && ex1[3].includes('one or more'));

const ex2 = explainPattern('(?<year>\\d{4})|(?:ab)+');
console.log(ex2.map((l) => `      ${l}`).join('\n'));
truthy('explains named groups and alternation',
  ex2.some((l) => l.includes('"year"')) && ex2.some((l) => l.includes('— or —')));

// Malformed input must terminate, not spin. Each of these previously hung.
truthy('terminates on malformed input', (() => {
  for (const p of ['[', '(', '\\', '{2,', 'a{', '(?<', '[a-', '', '*', '}', '+++', 'a{2', '((((']) {
    try { explainPattern(p); } catch { return false; }
  }
  return true;
})());

console.log('\n--- escapeLiteral ---');
truthy('escaped text matches itself', (() => {
  const raw = 'a.b*c(d)[e]{f}|g^h$i+j?k\\l/m';
  return new RegExp(`^${escapeLiteral(raw)}$`).test(raw);
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
