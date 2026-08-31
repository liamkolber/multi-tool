// Does every source file still parse, and is any of it half-merged?
//
// The rest of the suite reads source as text — wiring.test.mjs scans it with
// regexes, styles.test.mjs looks for CSS rules — so all 179 assertions passed
// happily while lib/tools/art.mjs and public/lib/art.js each began with
// "<<<<<<< HEAD" and could not be parsed at all. Green tests, dead app.
//
// So: parse every script, and look for conflict markers in everything,
// including the files no parser would object to (CSS, JSON, HTML).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname } from 'node:path';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  cond ? pass++ : fail++;
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'downloads']);
const TEXT_EXT = new Set(['.mjs', '.js', '.css', '.json', '.html', '.md']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

const files = walk('.');
const scripts = files.filter((f) => ['.mjs', '.js'].includes(extname(f)));

console.log('--- every script parses ---');
const unparseable = [];
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    const first = String(err.stderr || '').split('\n').find((l) => /Error|\^/.test(l)) || 'parse error';
    unparseable.push(`${file}: ${first.trim()}`);
  }
}
check(`all ${scripts.length} .js/.mjs files parse`,
  unparseable.length === 0, unparseable.join('\n      '));

console.log('\n--- nothing is half-merged ---');
// Anchored to line starts so prose about conflict markers does not trip it.
const MARKER = /^(<{7} |={7}$|>{7} )/m;
const conflicted = files.filter((f) => MARKER.test(readFileSync(f, 'utf8')));
check(`no conflict markers in ${files.length} files`,
  conflicted.length === 0, conflicted.join(', '));

console.log('\n--- JSON files are valid JSON ---');
const badJson = [];
for (const file of files.filter((f) => extname(f) === '.json')) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    badJson.push(`${file}: ${err.message}`);
  }
}
check('every .json parses', badJson.length === 0, badJson.join('; '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
