// Pulls the duplicate-detection logic out of library.js and runs it against
// fixtures modelled on the cases that actually turn up in a real library.
import { readFileSync } from 'node:fs';

const src = readFileSync('public/tools/library.js', 'utf8');

const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${what}`);
  return m[0];
};

const api = new Function(`
  ${grab(/const NOISE = \/.*?\/gi;/s, 'NOISE')}
  ${grab(/const MIN_KEY_LEN = \d+;/, 'MIN_KEY_LEN')}
  ${grab(/const MIN_DUP_DURATION = \d+;/, 'MIN_DUP_DURATION')}
  ${grab(/function lbTitleKey\(name\) \{[\s\S]*?\n\}/, 'lbTitleKey')}
  ${grab(/function groupBy\(files, keyOf\) \{[\s\S]*?\n\}/, 'groupBy')}
  ${grab(/function lbDuplicates\(files\) \{[\s\S]*?\n\}/, 'lbDuplicates')}
  ${grab(/function lbIsDuplicate\(d\) \{[\s\S]*?\n\}/, 'lbIsDuplicate')}
  ${grab(/function lbDupeReason\(d\) \{[\s\S]*?\n\}/, 'lbDupeReason')}
  return { lbTitleKey, lbDuplicates, lbIsDuplicate, lbDupeReason };
`)();

const { lbDuplicates, lbIsDuplicate, lbDupeReason } = api;

const v = (name, size, duration, sig = null) =>
  ({ path: `X:\\${name}`, name, kind: 'video', size, duration, sig });

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  cond ? pass++ : fail++;
};

// The library the server actually produced for these cases.
const FILES = [
  v('Interstellar.2014.1080p.BluRay.mkv', 592002, 40, 'e923ff478540b641'),
  v('vid_0093_final_RENAMED.mkv', 592002, 40, 'e923ff478540b641'),   // byte-identical copy
  v('some_random_name_720.mp4', 469795, 40),                          // re-encode of the same
  v('Gravity.2013.1080p.mkv', 591831, 40),                            // different film, same length
  v('ASMR _ Haul _ triggers-1080p.mp4', 532590, 35),                  // same normalised name…
  v('ASMR _ Haul (yay) _ triggers-1080p.mp4', 187227, 12),            // …but a different video
  v('clip1.mp4', 71561, 5),                                           // short, identical length
  v('clip2.mp4', 71442, 5),
];

const d = lbDuplicates(FILES);
const of = (name) => d.get(`X:\\${name}`);
const reason = (name) => {
  const info = of(name);
  return lbIsDuplicate(info) ? lbDupeReason(info) : '(not flagged)';
};

console.log('--- what each file was matched on ---');
for (const f of FILES) console.log(`      ${f.name.padEnd(40)} ${reason(f.name)}`);

console.log('\n--- a renamed copy is caught with certainty ---');
check('byte-identical pair reads as identical',
  of('Interstellar.2014.1080p.BluRay.mkv').identical
  && of('vid_0093_final_RENAMED.mkv').identical);
check('…and reports that as the reason',
  reason('vid_0093_final_RENAMED.mkv') === 'identical file');
check('a wholly unrelated name is no obstacle',
  lbIsDuplicate(of('vid_0093_final_RENAMED.mkv')));

console.log('\n--- a re-encode is caught on running time, not bytes ---');
check('re-encode flagged despite different size',
  lbIsDuplicate(of('some_random_name_720.mp4')));
check('and it is NOT claimed to be identical',
  !of('some_random_name_720.mp4').identical,
  reason('some_random_name_720.mp4'));

console.log('\n--- the weak signal no longer fires on its own ---');
// Two different videos whose release names normalise the same. Under the old
// name-only rule both were flagged; now the running times disagree, so neither
// counts as a probable duplicate.
check('same name + different length is not a duplicate',
  !lbIsDuplicate(of('ASMR _ Haul _ triggers-1080p.mp4'))
  && !lbIsDuplicate(of('ASMR _ Haul (yay) _ triggers-1080p.mp4')));
check('but the name match is still recorded',
  of('ASMR _ Haul _ triggers-1080p.mp4').name === true);

console.log('\n--- short clips are not evidence ---');
check('5s files of equal length are ignored',
  !d.has('X:\\clip1.mp4') && !d.has('X:\\clip2.mp4'));

console.log('\n--- honest about what it cannot know ---');
// Gravity really is 40 seconds long, same as the Interstellar set. Length alone
// cannot tell them apart, and the label says "same length" rather than claiming
// they are the same file.
check('a coincidental length match is labelled as such',
  reason('Gravity.2013.1080p.mkv') === 'same length');
check('it is never called identical',
  !of('Gravity.2013.1080p.mkv').identical);

console.log('\n--- a library with nothing in common stays quiet ---');
const clean = lbDuplicates([
  v('a.mkv', 100, 100), v('b.mkv', 200, 200), v('c.mkv', 300, 300),
]);
check('no false positives on distinct files', clean.size === 0);

console.log('\n--- signatures are only trusted alongside a size match ---');
const sameSigDiffSize = lbDuplicates([
  v('x.mkv', 100, 90, 'abc'), v('y.mkv', 200, 90, 'abc'),
]);
check('same sig but different size is not identical',
  !sameSigDiffSize.get('X:\\x.mkv').identical);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
