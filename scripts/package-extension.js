// Builds the extension and zips it for sharing or store upload:
//
//   npm run package:extension   ->  extension/locator-agent-extension-<version>.zip
//
// The zip holds only what the browser needs (manifest, icons, built scripts),
// with manifest.json at the top level. Written without dependencies: a zip is a
// list of deflated entries plus a directory at the end.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildExtension } = require('./build-extension');

const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'extension');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip `files` ([{ name, data }]) into a Buffer. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp keeps the archive reproducible: 2020-01-01 00:00
  const dosTime = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Every file under `dir`, as zip entries named relative to `base` with forward slashes. */
function collect(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full, base));
    else out.push({ name: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
  }
  return out;
}

async function packageExtension() {
  await buildExtension();
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const files = [
    { name: 'manifest.json', data: fs.readFileSync(path.join(extDir, 'manifest.json')) },
    ...collect(path.join(extDir, 'icons'), extDir),
    ...collect(path.join(extDir, 'dist'), extDir),
  ];
  const out = path.join(extDir, `locator-agent-extension-${manifest.version}.zip`);
  fs.writeFileSync(out, zip(files));
  return { out, files: files.map((f) => f.name) };
}

module.exports = { packageExtension, zip };

if (require.main === module) {
  packageExtension()
    .then(({ out, files }) => console.log(`Wrote ${path.relative(root, out)} (${files.length} files)`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
