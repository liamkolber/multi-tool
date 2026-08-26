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
  ${grab(/const MIN_DUP_DURATION = \d+;/, 'MIN_DUP_DURATION')}
  ${grab(/const LENGTH_TOLERANCE = [\d.]+;/, 'LENGTH_TOLERANCE')}
  ${grab(/const SIZE_TOLERANCE = [\d.]+;/, 'SIZE_TOLERANCE')}
  ${grab(/function clusterBy\(files, valueOf, withinTolerance\) \{[\s\S]*?\n\}/, 'clusterBy')}
  ${grab(/function membersOf\(sets\) \{[\s\S]*?\n\}/, 'membersOf')}
  ${grab(/function lbNameKey\(name\) \{[\s\S]*?\n\}/, 'lbNameKey')}
  ${grab(/function groupBy\(files, keyOf\) \{[\s\S]*?\n\}/, 'groupBy')}
  ${grab(/function lbDuplicates\(files\) \{[\s\S]*?\n\}/, 'lbDuplicates')}
  ${grab(/function lbIsDuplicate\(d\) \{[\s\S]*?\n\}/, 'lbIsDuplicate')}
  ${grab(/function lbDupeReason\(d\) \{[\s\S]*?\n\}/, 'lbDupeReason')}
  return { lbNameKey, lbDuplicates, lbIsDuplicate, lbDupeReason };
`)();

const { lbDuplicates, lbIsDuplicate, lbDupeReason } = api;

// Distinct folders, because two files cannot share a name in one.
const v = (dir, name, size, duration, sig = null, width = null, height = null) =>
  ({ path: `X:\\${dir}\\${name}`, dir: `X:\\${dir}`, name, kind: 'video', size, duration, sig, width, height });

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(48)} ${detail}`);
  cond ? pass++ : fail++;
};

const FILES = [
  v('A', 'Interstellar.2014.1080p.BluRay.mkv', 592002, 40, 'e923ff478540b641'),
  v('B', 'vid_0093_final_RENAMED.mkv', 592002, 40, 'e923ff478540b641'),  // byte-identical copy
  v('B', 'some_random_name_720.mp4', 469795, 40),                        // re-encode of the same
  v('A', 'Gravity.2013.1080p.mkv', 591831, 40),                          // different film, same length
  v('A', 'holiday.mp4', 111, 90),                                        // same filename in two…
  v('B', 'holiday.mp4', 222, 120),                                       // …folders, nothing else alike
  v('A', 'HOLIDAY.MP4'.toLowerCase() === 'holiday.mp4' ? 'Holiday2.mp4' : 'x', 333, 150),
  v('A', 'clip1.mp4', 71561, 5),                                         // short, identical length
  v('B', 'clip2.mp4', 71442, 5),
];

const d = lbDuplicates(FILES);
const at = (dir, name) => d.get(`X:\\${dir}\\${name}`);
const reason = (dir, name) => {
  const info = at(dir, name);
  return lbIsDuplicate(info) ? lbDupeReason(info) : '(not flagged)';
};

console.log('--- what each file was matched on ---');
for (const f of FILES) console.log(`      ${(`${f.dir.slice(3)}\\${f.name}`).padEnd(42)} ${reason(f.dir.slice(3), f.name)}`);

console.log('\n--- a renamed copy is caught with certainty ---');
check('byte-identical pair reads as identical',
  at('A', 'Interstellar.2014.1080p.BluRay.mkv').identical && at('B', 'vid_0093_final_RENAMED.mkv').identical);
check('…and reports that as the reason',
  reason('B', 'vid_0093_final_RENAMED.mkv').startsWith('identical file'),
  reason('B', 'vid_0093_final_RENAMED.mkv'));

console.log('\n--- a re-encode is caught on running time, not bytes ---');
check('re-encode flagged despite different size', lbIsDuplicate(at('B', 'some_random_name_720.mp4')));
check('and it is NOT claimed to be identical', !at('B', 'some_random_name_720.mp4').identical);

console.log('\n--- the name signal is an exact filename match ---');
check('same filename in two folders is flagged',
  at('A', 'holiday.mp4').name === true && at('B', 'holiday.mp4').name === true);
check('…even with different sizes and lengths',
  lbIsDuplicate(at('A', 'holiday.mp4')) && !at('A', 'holiday.mp4').identical && !at('A', 'holiday.mp4').length,
  reason('A', 'holiday.mp4'));
check('a merely similar filename is not', !at('A', 'Holiday2.mp4'));

// The regression this replaced. These share everything the old normaliser kept
// — the trailing "- NNNNN" was stripped as if it were a release group — so all
// four collapsed onto one key and were reported as duplicates of each other.
console.log('\n--- release-name normalising no longer collapses unrelated files ---');
const telegram = lbDuplicates([
  v('t', '\u26a1@LE4KSXHUB ON TELEGRAM - 13177.mov', 2300, 15),
  v('t2', '\u26a1@LE4KSXHUB ON TELEGRAM - 13144.mp4', 1300, 30),
  v('t3', '\u26a1@LE4KSXHUB ON TELEGRAM - 13143.mp4', 688, 15),
  v('t4', '\u26a1@LE4KSXHUB ON TELEGRAM - 863.mp4', 635, 10),
]);
check('four differently-numbered files are not one set', telegram.size === 0,
  `${telegram.size} flagged`);

const spank = lbDuplicates([
  v('s', 'SpankBang.com_alyssa+pusy_1080p (1).mp4', 3100, 133),
  v('s2', 'SpankBang.com_alyssa+pusy_1080p (2).mp4', 2600, 113),
]);
check('"(1)" and "(2)" of different lengths are not a set', spank.size === 0,
  `${spank.size} flagged`);

console.log('\n--- short clips are not evidence ---');
check('5s files of equal length are ignored', !at('A', 'clip1.mp4') && !at('B', 'clip2.mp4'));

console.log('\n--- honest about what it cannot know ---');
check('a coincidental length match is labelled as such',
  reason('A', 'Gravity.2013.1080p.mkv').startsWith('same length'),
  reason('A', 'Gravity.2013.1080p.mkv'));
check('it is never called identical', !at('A', 'Gravity.2013.1080p.mkv').identical);

console.log('\n--- sets have an identity, so they can be sorted together ---');
const idA = at('A', 'Interstellar.2014.1080p.BluRay.mkv').groupId;
const idB = at('B', 'vid_0093_final_RENAMED.mkv').groupId;
check('an identical pair shares one group', idA === idB, `ids ${idA}/${idB}`);
check('and that group holds exactly the two of them',
  at('A', 'Interstellar.2014.1080p.BluRay.mkv').groupCount === 2);
check('a length-only match groups separately',
  at('A', 'Gravity.2013.1080p.mkv').groupId !== idA);
check('waste counts every copy but the largest',
  at('B', 'vid_0093_final_RENAMED.mkv').groupWaste === 592002,
  String(at('B', 'vid_0093_final_RENAMED.mkv').groupWaste));

console.log('\n--- a library with nothing in common stays quiet ---');
const clean = lbDuplicates([
  v('a', 'a.mkv', 100, 100), v('b', 'b.mkv', 200, 200), v('c', 'c.mkv', 300, 300),
]);
check('no false positives on distinct files', clean.size === 0);

console.log('\n--- signatures are only trusted alongside a size match ---');
const sameSigDiffSize = lbDuplicates([
  v('a', 'x.mkv', 100, 90, 'abc'), v('b', 'y.mkv', 200, 90, 'abc'),
]);
check('same sig but different size is not identical',
  !sameSigDiffSize.get('X:\\a\\x.mkv').identical);

console.log('\n--- length matching is a tolerance, not a rounding ---');
// Rounding to the nearest second put 1999.6 and 2000.4 in different buckets
// while 2000.4 and 2000.6 shared one. A tolerance does neither.
const drift = lbDuplicates([
  v('a', 'one.mkv', 500, 1999.98),
  v('b', 'two.mkv', 900, 2000.31),   // 0.33s apart — the same cut, re-encoded
  v('c', 'far.mkv', 700, 2003.00),   // 3s apart — a different video
]);
check('a third of a second apart is one set',
  !!drift.get('X:\\a\\one.mkv') && !!drift.get('X:\\b\\two.mkv'));
check('three seconds apart is not', !drift.get('X:\\c\\far.mkv'));

console.log('\n--- a set cannot chain its way across the library ---');
// Each file is within tolerance of the previous one but far from the first.
// Anchoring on the run's first member is what stops one set swallowing them all.
const chain = lbDuplicates(Array.from({ length: 40 }, (_, i) =>
  v(`d${i}`, `c${i}.mkv`, 100 + i, 600 + i * 0.4)));
const sets = new Set([...chain.values()].map((x) => x.groupId));
check('40 files drifting 0.4s apart do not become one set', sets.size > 1,
  `${sets.size} sets`);

console.log('\n--- the tighter cuts through a length set ---');
const cut = lbDuplicates([
  v('a', 'big.mkv', 1_000_000, 1200, null, 1920, 1080),
  v('b', 'similar.mkv', 1_060_000, 1200.2, null, 1920, 1080),  // +6% size, same dims
  v('c', 'smaller.mp4', 300_000, 1200.1, null, 640, 480),      // same length only
]);
const A = cut.get('X:\\a\\big.mkv');
const C = cut.get('X:\\c\\smaller.mp4');
check('similar size within a length set reads as "close"', A.close === true);
check('same resolution within a length set reads as "shape"', A.shape === true);
check('a wildly different size does not', C.close !== true, `close=${C.close}`);
check('nor a different resolution', C.shape !== true, `shape=${C.shape}`);
check('but it is still a length match', C.length === true);
check('and the reason names the tightest signal',
  lbDupeReason(A).startsWith('same length and size'), lbDupeReason(A));
check('while the loose one says only what it knows',
  lbDupeReason(C).startsWith('same length'), lbDupeReason(C));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
