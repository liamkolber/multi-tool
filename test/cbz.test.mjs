// The zip writer, checked against a standard unzipper.
//
// Hand-rolled archive headers are exactly the kind of thing that looks right
// and unpacks wrong, so this does not inspect its own output: it hands the
// file to Windows' own Expand-Archive, which refuses a malformed central
// directory rather than guessing, and compares every page byte-for-byte.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCbz, naturalSort } from '../lib/cbz.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  cond ? pass++ : fail++;
};

console.log('--- page ordering ---');
const messy = ['page10.webp', 'page2.webp', 'page1.webp', 'page20.webp', 'cover.webp'];
const sorted = messy.slice().sort(naturalSort);
check('digits sort as numbers, not text',
  sorted.join(',') === 'cover.webp,page1.webp,page2.webp,page10.webp,page20.webp',
  sorted.join(' < '));
check('page 10 does not come before page 2',
  sorted.indexOf('page2.webp') < sorted.indexOf('page10.webp'));

const ffmpeg = existsSync('bin/ffmpeg.exe') ? 'bin/ffmpeg.exe' : 'ffmpeg';
let haveFfmpeg = true;
try {
  execFileSync(ffmpeg, ['-version'], { stdio: 'pipe' });
} catch {
  haveFfmpeg = false;
}

if (!haveFfmpeg) {
  console.log('\n--- archive round-trip ---');
  console.log('ok    skipped: ffmpeg not available to make test images');
} else {
  const root = mkdtempSync(join(tmpdir(), 'cbz-'));
  const src = join(root, 'pages');
  const out = join(root, 'out');
  mkdirSync(src, { recursive: true });
  mkdirSync(out, { recursive: true });

  try {
    // Real webp files rather than fabricated bytes, so this tests the thing
    // the tool will actually be handed.
    for (let i = 0; i < messy.length; i++) {
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=0x${(i * 40).toString(16).padStart(2, '0')}4080:s=64x96`,
        '-frames:v', '1', join(src, messy[i]),
      ], { stdio: 'pipe' });
    }

    const files = readdirSync(src).sort(naturalSort).map((n) => join(src, n));
    const cbz = join(out, 'chapter.cbz');
    let lastDone = 0;
    const result = await writeCbz(files, cbz, { onProgress: (d) => { lastDone = d; } });

    console.log('\n--- archive round-trip ---');
    check('every page written', result.entries === messy.length, `${result.entries} entries`);
    check('progress reached the last page', lastDone === messy.length);

    // Expand-Archive only takes .zip, and a cbz is a zip.
    const asZip = join(out, 'check.zip');
    writeFileSync(asZip, readFileSync(cbz));
    const unpacked = join(out, 'unpacked');
    let accepted = true;
    let why = '';
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${asZip}' -DestinationPath '${unpacked}' -Force`], { stdio: 'pipe' });
    } catch (err) {
      accepted = false;
      why = String(err.stderr || err).slice(0, 160);
    }
    check('a standard unzipper accepts it', accepted, why);

    if (accepted) {
      const got = readdirSync(unpacked);
      check('all pages present after unpacking', got.length === messy.length, got.join(', '));

      let identical = 0;
      for (const name of got) {
        if (Buffer.compare(readFileSync(join(src, name)), readFileSync(join(unpacked, name))) === 0) identical++;
      }
      check('pages are byte-for-byte identical', identical === messy.length,
        `${identical}/${messy.length}`);
    }

    // An empty archive is a corrupt one; refusing beats producing it.
    let refusedEmpty = false;
    try {
      await writeCbz([], join(out, 'empty.cbz'));
    } catch {
      refusedEmpty = true;
    }
    check('refuses to write an archive with no pages', refusedEmpty);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
