/* ==========================================================================
 * SayZip — a tiny, dependency-free ZIP reader/writer.
 *
 *   - read(arrayBuffer) -> Promise<[{ name, data: Uint8Array }]>
 *       Parses the central directory; inflates DEFLATE entries with the native
 *       DecompressionStream and copies STORED entries. UTF-8 names.
 *   - write(files)      -> Promise<Blob>     (files: [{ name, data }])
 *       Writes a valid STORED (uncompressed) ZIP with correct CRC-32s — small
 *       enough that compression isn't worth the complexity, and Tampermonkey
 *       reads it fine.
 *
 * No CDN / remote code (MV3 CSP-safe). Works in the options page and Node.
 * ======================================================================== */
(function (root) {
  'use strict';

  // --- CRC-32 -------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    const year = Math.max(1980, d.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime: dosTime & 0xFFFF, dosDate: dosDate & 0xFFFF };
  }

  // --- write (STORED) -----------------------------------------------------
  async function write(files, when) {
    const enc = new TextEncoder();
    const local = [];
    const central = [];
    let offset = 0;
    const { dosTime, dosDate } = dosDateTime(when || new Date());

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = (typeof f.data === 'string') ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const size = data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);       // version needed
      lh.setUint16(6, 0x0800, true);   // flags: bit 11 = UTF-8 filename
      lh.setUint16(8, 0, true);        // method: 0 = stored
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);    // compressed size
      lh.setUint32(22, size, true);    // uncompressed size
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);       // extra length
      local.push(new Uint8Array(lh.buffer), nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);       // version made by
      ch.setUint16(6, 20, true);       // version needed
      ch.setUint16(8, 0x0800, true);   // flags
      ch.setUint16(10, 0, true);       // method
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true);       // extra
      ch.setUint16(32, 0, true);       // comment
      ch.setUint16(34, 0, true);       // disk number
      ch.setUint16(36, 0, true);       // internal attrs
      ch.setUint32(38, 0, true);       // external attrs
      ch.setUint32(42, offset, true);  // local header offset
      central.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, centralStart, true);
    eocd.setUint16(20, 0, true);

    return new Blob([...local, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
  }

  // --- read ---------------------------------------------------------------
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function read(buffer) {
    const bytes = (buffer instanceof Uint8Array) ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Locate End Of Central Directory (scan backwards over the optional comment).
    let eocd = -1;
    const minPos = Math.max(0, bytes.length - 22 - 0xFFFF);
    for (let i = bytes.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no End Of Central Directory).');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const entries = [];

    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt central directory.');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ method, compSize, lho, name });
      p += 46 + nameLen + extraLen + commentLen;
    }

    const out = [];
    for (const e of entries) {
      if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error('Corrupt local header for ' + e.name);
      const lNameLen = dv.getUint16(e.lho + 26, true);
      const lExtraLen = dv.getUint16(e.lho + 28, true);
      const start = e.lho + 30 + lNameLen + lExtraLen;
      const comp = bytes.subarray(start, start + e.compSize);
      let data;
      if (e.method === 0) data = comp.slice();
      else if (e.method === 8) data = await inflateRaw(comp);
      else throw new Error('Unsupported compression (method ' + e.method + ') in ' + e.name);
      out.push({ name: e.name, data });
    }
    return out;
  }

  const SayZip = { read, write, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = SayZip;
  else root.SayZip = SayZip;
})(typeof self !== 'undefined' ? self : this);
