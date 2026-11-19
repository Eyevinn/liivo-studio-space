'use strict';
// Builds gzip'd ustar archives in a test, byte by byte, so a test can make a member the system tar would refuse
// to write (`../`, an absolute path, a symlink). Not part of the image.
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function field(buf, off, len, value) {
  Buffer.from(value, 'utf8').copy(buf, off, 0, len);
}

function header(name, { type = '0', size = 0, mode = 0o644, link = '' } = {}) {
  const h = Buffer.alloc(512);
  field(h, 0, 100, name);
  field(h, 100, 8, `${mode.toString(8).padStart(7, '0')}\0`);
  field(h, 108, 8, '0000000\0');
  field(h, 116, 8, '0000000\0');
  field(h, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  field(h, 136, 12, '00000000000\0');
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  field(h, 157, 100, link);
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

const pad = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);

// One pax record: "<length> <key>=<value>\n", the length counting itself.
function paxRecord(key, value) {
  const rest = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
  return Buffer.from(`${len}${rest}`);
}

// entries: [{ name, data?: string|Buffer, type?, link? }]. A name over 100 bytes is written as GNU does (an `L` entry).
function tgz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data || '');
    let name = e.name;
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(`${name}\0`);
      parts.push(header('././@LongLink', { type: 'L', size: long.length }), pad(long));
      name = name.slice(0, 99);
    }
    const type = e.type || (e.name.endsWith('/') ? '5' : '0');
    if (e.pax) {
      // e.pax: [[key, value], ...] written as one pax extended header before the member.
      const body = Buffer.concat(e.pax.map(([k, v]) => paxRecord(k, v)));
      parts.push(header('PaxHeader/x', { type: 'x', size: body.length }), pad(body));
    }
    parts.push(header(name, { type, size: type === '0' ? data.length : 0, link: e.link || '', mode: type === '5' ? 0o755 : 0o644 }));
    if (type === '0') parts.push(pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { mtime: 0 });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A bridge package as the gateway packs it: package/, VERSION.json, server.mjs and a few files, one of them with a long path.
function bridgePackage(version, { extra = [], serverSource } = {}) {
  const source =
    serverSource ||
    "import http from 'node:http';\nhttp.createServer((q, r) => { r.end('bridge ' + process.argv[1]); }).listen(Number(process.env.LIIVO_BRIDGE_PORT), '127.0.0.1', () => console.log('listening'));\n";
  const long = `package/node_modules/${'deeply-nested-'.repeat(8)}/index.js`;
  return tgz([
    { name: 'package/' },
    { name: 'package/VERSION.json', data: `${JSON.stringify({ version, protocol: 1 })}\n` },
    { name: 'package/server.mjs', data: source },
    { name: 'package/node_modules/' },
    { name: long, data: 'module.exports = 1;\n' },
    ...extra,
  ]);
}

module.exports = { tgz, sha256, bridgePackage };
