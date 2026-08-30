// The treemap layout and the tree it lays out.
//
// A treemap's only job is that area is proportional to size. If that slips, it
// still looks like a chart — it just lies, which is worse than not having one.
import { readFileSync } from 'node:fs';

const src = readFileSync('public/tools/library.js', 'utf8');

const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${what}`);
  return m[0];
};

const api = new Function('FOLDERS', `
  const lbFolders = FOLDERS;
  ${grab(/function lbTree\(\) \{[\s\S]*?\n\}/, 'lbTree')}
  ${grab(/function lbLayout\(items, x, y, w, h, out, depth\) \{[\s\S]*?\n\}/, 'lbLayout')}
  return { lbTree, lbLayout };
`);

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(48)} ${detail}`);
  cond ? pass++ : fail++;
};

const fd = (rel, size, ownSize = 0, files = 1) => ({
  path: `X:\\root${rel ? `\\${rel}` : ''}`,
  rel,
  name: rel ? rel.split('\\').pop() : 'root',
  depth: rel ? rel.split('\\').length : 0,
  size,
  files,
  ownSize,
  ownFiles: ownSize ? 1 : 0,
});

const { lbTree, lbLayout } = api([
  fd('', 1000, 100),
  fd('Movies', 600, 100),
  fd('Movies\\Action', 500, 500),
  fd('TV', 300, 300),
]);

console.log('--- the flat folder list becomes a tree ---');
const tree = lbTree();
check('every folder is a node', tree.size === 4);
check('top level hangs off the root',
  tree.get('').children.map((c) => c.rel).sort().join(',') === 'Movies,TV',
  tree.get('').children.map((c) => c.rel).join(', '));
check('a nested folder hangs off its parent',
  tree.get('Movies').children.length === 1 && tree.get('Movies').children[0].rel === 'Movies\\Action');
check('a leaf has no children', tree.get('TV').children.length === 0);
check('the root is not its own child',
  !tree.get('').children.some((c) => c.rel === ''));

console.log('\n--- layout: area is proportional to value ---');
const W = 800;
const H = 400;
const items = [
  { value: 500, label: 'a' },
  { value: 300, label: 'b' },
  { value: 150, label: 'c' },
  { value: 50, label: 'd' },
];
const tiles = [];
lbLayout(items, 0, 0, W, H, tiles, 0);

check('every item gets exactly one tile', tiles.length === items.length);

const total = items.reduce((n, i) => n + i.value, 0);
let worstErr = 0;
for (const t of tiles) {
  const expected = (t.item.value / total) * (W * H);
  const actual = t.w * t.h;
  worstErr = Math.max(worstErr, Math.abs(actual - expected) / expected);
}
check('areas match their share within 0.1%', worstErr < 0.001,
  `worst error ${(worstErr * 100).toFixed(4)}%`);

const covered = tiles.reduce((n, t) => n + t.w * t.h, 0);
check('the tiles fill the frame exactly', Math.abs(covered - W * H) < 1,
  `${covered.toFixed(1)} of ${W * H}`);

console.log('\n--- layout: tiles do not overlap ---');
const overlaps = (a, b) =>
  a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001
  && a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001;
let clash = null;
for (let i = 0; i < tiles.length; i++) {
  for (let j = i + 1; j < tiles.length; j++) {
    if (overlaps(tiles[i], tiles[j])) clash = `${tiles[i].item.label} / ${tiles[j].item.label}`;
  }
}
check('no two tiles overlap', clash === null, clash || '');

check('every tile is inside the frame',
  tiles.every((t) => t.x >= -0.001 && t.y >= -0.001 && t.x + t.w <= W + 0.001 && t.y + t.h <= H + 0.001));

console.log('\n--- layout: shapes stay usable ---');
// Splitting along the longer side is what stops tiles becoming slivers. A naive
// slice-and-dice would give the smallest item an aspect ratio in the hundreds.
let worstAspect = 0;
for (const t of tiles) worstAspect = Math.max(worstAspect, Math.max(t.w / t.h, t.h / t.w));
check('no tile is a sliver', worstAspect < 12, `worst aspect ${worstAspect.toFixed(1)}:1`);

console.log('\n--- layout: the awkward inputs ---');
const one = [];
lbLayout([{ value: 5, label: 'only' }], 0, 0, 100, 50, one, 0);
check('a single item takes the whole frame',
  one.length === 1 && one[0].w === 100 && one[0].h === 50);

const none = [];
lbLayout([], 0, 0, 100, 50, none, 0);
check('no items lays out nothing', none.length === 0);

const zero = [];
lbLayout([{ value: 0, label: 'z' }, { value: 0, label: 'z2' }], 0, 0, 100, 50, zero, 0);
check('all-zero values do not divide by zero', zero.length === 0 || zero.every((t) => Number.isFinite(t.w)));

const flat = [];
lbLayout(Array.from({ length: 200 }, (_, i) => ({ value: 1, label: `i${i}` })), 0, 0, 900, 500, flat, 0);
check('200 equal items all get a tile', flat.length === 200);
check('…and none of them collapse to nothing',
  flat.every((t) => t.w > 0 && t.h > 0));

const lopsided = [];
lbLayout([{ value: 1e9, label: 'huge' }, { value: 1, label: 'crumb' }], 0, 0, 800, 400, lopsided, 0);
check('a crumb beside a giant still gets a tile',
  lopsided.length === 2 && lopsided.every((t) => Number.isFinite(t.w) && Number.isFinite(t.h)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
