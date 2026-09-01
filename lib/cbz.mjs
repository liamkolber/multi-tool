// A minimal ZIP writer, which is all a CBZ is: images in a zip, renamed.
//
// Store-only, no compression. That is not a shortcut — JPEG, PNG and WebP are
// already compressed, so deflating them costs CPU to save roughly nothing, and
// every comic reader handles stored entries. Readers order pages by filename,
// so the caller sorts and this writes in the order it is given.
//
// Written by hand because the app carries no dependencies. The format is small
// enough to be worth that: a local header per file, a central directory, and
// an end-of-directory record.
import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

// Standard CRC-32 (IEEE 802.3), the one zip requires. Table built once.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Zip stores time as MS-DOS fields: seconds in 2-second units, years from 1980.
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

// Beyond these a zip needs the ZIP64 extensions, which this does not write.
// Refusing is better than emitting an archive that looks fine and unpacks
// wrong: the fields simply overflow, silently.
const MAX_ENTRIES = 65535;
const MAX_BYTES = 0xfffffffe;

const CHUNK = 1 << 20;

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const buf = Buffer.alloc(30 + name.length);
  buf.writeUInt32LE(LOCAL_SIG, 0);
  buf.writeUInt16LE(20, 4);            // version needed: 2.0
  buf.writeUInt16LE(0x0800, 6);        // flags: names are UTF-8
  buf.writeUInt16LE(0, 8);             // method: stored
  buf.writeUInt16LE(entry.time, 10);
  buf.writeUInt16LE(entry.date, 12);
  buf.writeUInt32LE(entry.crc, 14);
  buf.writeUInt32LE(entry.size, 18);   // compressed
  buf.writeUInt32LE(entry.size, 22);   // uncompressed
  buf.writeUInt16LE(name.length, 26);
  buf.writeUInt16LE(0, 28);            // no extra field
  name.copy(buf, 30);
  return buf;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const buf = Buffer.alloc(46 + name.length);
  buf.writeUInt32LE(CENTRAL_SIG, 0);
  buf.writeUInt16LE(20, 4);            // version made by
  buf.writeUInt16LE(20, 6);            // version needed
  buf.writeUInt16LE(0x0800, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(entry.time, 12);
  buf.writeUInt16LE(entry.date, 14);
  buf.writeUInt32LE(entry.crc, 16);
  buf.writeUInt32LE(entry.size, 20);
  buf.writeUInt32LE(entry.size, 24);
  buf.writeUInt16LE(name.length, 28);
  buf.writeUInt16LE(0, 30);            // extra
  buf.writeUInt16LE(0, 32);            // comment
  buf.writeUInt16LE(0, 34);            // disk number
  buf.writeUInt16LE(0, 36);            // internal attrs
  buf.writeUInt32LE(0, 38);            // external attrs
  buf.writeUInt32LE(entry.offset, 42);
  name.copy(buf, 46);
  return buf;
}

function endRecord(count, size, offset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(END_SIG, 0);
  buf.writeUInt16LE(0, 4);             // this disk
  buf.writeUInt16LE(0, 6);             // disk with central dir
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(size, 12);
  buf.writeUInt32LE(offset, 16);
  buf.writeUInt16LE(0, 20);            // no comment
  return buf;
}

const write = (stream, buf) => new Promise((resolve, reject) => {
  stream.write(buf, (err) => (err ? reject(err) : resolve()));
});

/**
 * Write `files` into `outPath` as a stored zip.
 *
 * @param {string[]} files    absolute paths, already in reading order
 * @param {string}   outPath  destination, typically ending .cbz
 * @param {object}   [opts]
 * @param {(done:number,total:number,name:string)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.cancelled]  polled between files
 * @param {(i:number,path:string)=>string} [opts.nameFor]  entry name override
 * @returns {Promise<{entries:number, bytes:number}>}
 */
export async function writeCbz(files, outPath, opts = {}) {
  if (!files.length) throw new Error('No pages to write.');
  if (files.length > MAX_ENTRIES) {
    throw new Error(`${files.length} pages is beyond what a plain zip can index (${MAX_ENTRIES}).`);
  }

  const stream = createWriteStream(outPath);
  const entries = [];
  let offset = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      if (opts.cancelled && opts.cancelled()) throw new Error('cancelled');

      const path = files[i];
      const info = await stat(path);
      if (offset + info.size > MAX_BYTES) {
        throw new Error('Archive would pass 4 GB, which a plain zip cannot address.');
      }

      // Two passes over each file: one to checksum, one to copy. A stored
      // entry has to declare its CRC and size in the header that precedes the
      // data, and the alternative — buffering whole pages in memory — is worse
      // for exactly the large scans this is for.
      const name = opts.nameFor ? opts.nameFor(i, path) : basename(path);
      let crc = 0;
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
          if (!bytesRead) break;
          crc = crc32(buf.subarray(0, bytesRead), crc);
        }
      } finally {
        await fh.close();
      }

      const stamp = dosDateTime(info.mtime);
      const entry = { name, crc, size: info.size, offset, ...stamp };
      await write(stream, localHeader(entry));
      offset += 30 + Buffer.byteLength(name, 'utf8');

      const fh2 = await open(path, 'r');
      try {
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
          const { bytesRead } = await fh2.read(buf, 0, CHUNK, null);
          if (!bytesRead) break;
          await write(stream, buf.subarray(0, bytesRead));
          offset += bytesRead;
        }
      } finally {
        await fh2.close();
      }

      entries.push(entry);
      if (opts.onProgress) opts.onProgress(i + 1, files.length, name);
    }

    const dirOffset = offset;
    let dirSize = 0;
    for (const entry of entries) {
      const buf = centralHeader(entry);
      await write(stream, buf);
      dirSize += buf.length;
    }
    await write(stream, endRecord(entries.length, dirSize, dirOffset));

    await new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });

    return { entries: entries.length, bytes: dirOffset + dirSize + 22 };
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

// Pages are ordered by filename, and "10" must not sort before "2". Compares
// digit runs as numbers and everything else as text.
export function naturalSort(a, b) {
  const ax = String(a).toLowerCase().match(/(\d+|\D+)/g) || [];
  const bx = String(b).toLowerCase().match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d/.test(ax[i]);
    const bn = /^\d/.test(bx[i]);
    if (an && bn) {
      const diff = Number(ax[i]) - Number(bx[i]);
      if (diff) return diff;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}
