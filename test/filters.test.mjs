// The filter predicates and the AND semantics behind multi-select.
//
// Filters used to be one-at-a-time, so a wrong predicate only ever showed the
// wrong list. Combined, a wrong one silently empties the result and looks like
// "no duplicates" rather than a bug.
import { readFileSync } from 'node:fs';

const src = readFileSync('public/tools/library.js', 'utf8');

const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${what}`);
  return m[0];
};

// FILTERS leans on the duplicate map; a stub keyed by path is enough.
const api = new Function('DUPES', `
  const lbDupes = DUPES;
  ${grab(/function lbIsDuplicate\(d\) \{[\s\S]*?\n\}/, 'lbIsDuplicate')}
  ${grab(/const dupeOf = \(f\) => lbDupes\.get\(f\.path\) \|\| \{\};/, 'dupeOf')}
  ${grab(/const FILTERS = \[[\s\S]*?\n\];/, 'FILTERS')}
  return FILTERS;
`);

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  cond ? pass++ : fail++;
};

const f = (over = {}) => ({
  path: over.path || `X:\\${over.name || 'x.mkv'}`,
  name: 'x.mkv', dir: 'X:\\', kind: 'video',
  size: 100 * 1024 ** 2, duration: 600, width: 1920, height: 1080,
  vcodec: 'h264', acodec: 'aac', audioTracks: 1, subTracks: 0, sidecars: [],
  unreadable: false, sig: null, ...over,
});

const DUPES = new Map();
const FILTERS = api(DUPES);
const byId = new Map(FILTERS.map((x) => [x.id, x]));
const test = (id, file) => byId.get(id).test(file);

console.log('--- every filter is well formed ---');
check('ids are unique', new Set(FILTERS.map((x) => x.id)).size === FILTERS.length);
check('every filter has a group and a label',
  FILTERS.every((x) => x.group && x.label && typeof x.test === 'function'));
check('no filter is called "all"', !byId.has('all'),
  'the All chip clears the set rather than being one of them');

console.log('\n--- kind ---');
check('video', test('video', f({ kind: 'video' })) && !test('video', f({ kind: 'audio' })));
check('archive', test('archive', f({ kind: 'archive' })) && !test('archive', f({ kind: 'video' })));

console.log('\n--- quality ---');
check('below 1080p is by height, not width',
  test('sd', f({ width: 1920, height: 800 })) === false
  || test('sd', f({ width: 1440, height: 720 })) === true);
check('720p counts as below 1080p', test('sd', f({ height: 720 })));
check('1080p does not', !test('sd', f({ height: 1080 })));
check('1080p counts as HD', test('hd', f({ height: 1080 })));
check('vertical is height over width',
  test('vertical', f({ width: 1080, height: 1920 })) && !test('vertical', f({ width: 1920, height: 1080 })));
check('no audio', test('noaudio', f({ audioTracks: 0 })) && !test('noaudio', f({ audioTracks: 2 })));
check('no subtitles counts sidecars too',
  test('nosubs', f({ subTracks: 0, sidecars: [] }))
  && !test('nosubs', f({ subTracks: 0, sidecars: ['a.srt'] }))
  && !test('nosubs', f({ subTracks: 1, sidecars: [] })));

console.log('\n--- size and length ---');
check('over 4 GB', test('big', f({ size: 5 * 1024 ** 3 })) && !test('big', f({ size: 3 * 1024 ** 3 })));
check('under 20 MB', test('tiny', f({ size: 5 * 1024 ** 2 })) && !test('tiny', f({ size: 50 * 1024 ** 2 })));
check('a zero-byte file is not "tiny"', !test('tiny', f({ size: 0 })),
  'otherwise every unreadable file lands in it');
check('over an hour', test('longone', f({ duration: 3601 })) && !test('longone', f({ duration: 3599 })));
check('under 5 min', test('shortone', f({ duration: 299 })) && !test('shortone', f({ duration: 301 })));
check('a file with no duration is not "short"', !test('shortone', f({ duration: 0 })));

console.log('\n--- duplicate filters read the flags ---');
const dup = f({ path: 'X:\\d.mkv' });
DUPES.set(dup.path, { identical: true, close: true, shape: true, length: true, name: false });
check('identical', test('identical', dup));
check('same length & size', test('closesize', dup));
check('same length & resolution', test('sameshape', dup));
check('same filename is false when the flag is', !test('samename', dup));
check('a file with no entry matches no duplicate filter',
  !test('identical', f({ path: 'X:\\none.mkv' })) && !test('dupes', f({ path: 'X:\\none.mkv' })));

console.log('\n--- combining is AND, not OR ---');
const all = (ids, file) => ids.map((i) => byId.get(i)).every((x) => x.test(file));
const bigVertical = f({ path: 'X:\\bv.mkv', size: 5 * 1024 ** 3, width: 1080, height: 1920 });
check('a file satisfying both passes both', all(['big', 'vertical'], bigVertical));
check('failing either fails the pair',
  !all(['big', 'vertical'], f({ size: 5 * 1024 ** 3, width: 1920, height: 1080 }))
  && !all(['big', 'vertical'], f({ size: 1024, width: 1080, height: 1920 })));

// The combination that motivated multi-select: narrow duplicates to the ones
// actually worth reclaiming.
const bigDupe = f({ path: 'X:\\bd.mkv', size: 5 * 1024 ** 3 });
DUPES.set(bigDupe.path, { identical: false, close: true, shape: false, length: true, name: false });
check('"same length & size" plus "over 4 GB" narrows to both',
  all(['closesize', 'big'], bigDupe));
check('…and excludes a small one',
  !all(['closesize', 'big'], (() => {
    const small = f({ path: 'X:\\sd2.mkv', size: 10 * 1024 ** 2 });
    DUPES.set(small.path, { close: true, length: true });
    return small;
  })()));

console.log('\n--- mutually exclusive pairs really are ---');
check('below 1080p and 1080p-or-better share nothing',
  !all(['sd', 'hd'], f({ height: 720 })) && !all(['sd', 'hd'], f({ height: 1080 })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
