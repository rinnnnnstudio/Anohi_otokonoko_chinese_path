'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const AdmZip = require('./node_modules/adm-zip');
const zipUtils = require('./node_modules/adm-zip/util');
const root = __dirname;
const cnRoot = path.join(root);
const originalRoot = path.join(root);
const outputRoot = path.join(root);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function walk(dir) {
    return fs.readdirSync(dir, {withFileTypes: true})
        .flatMap(entry => {
            const file = path.join(dir, entry.name);
            return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
        }).sort();
}

const config = fs.readFileSync(path.join(originalRoot, 'data/system/Config.tjs'), 'utf8');
const projectID = config.match(/^;projectID=([^\r\n]+)/m)?.[1].trim();
if (projectID !== '01' || !/^;patch_apply_auto=true\s*$/m.test(config)) {
    throw new Error('Original game must have projectID=01 and patch_apply_auto=true.');
}
const translatedConfig = fs.readFileSync(path.join(cnRoot, 'data/system/Config.tjs'), 'utf8');
if (!/^;projectID=01\s*$/m.test(translatedConfig)) {
    throw new Error('Keep projectID=01 so patch loading and save names stay compatible.');
}

function makeZip(entries) {
    const localRecords = [], centralRecords = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.path, 'utf8');
        const compressed = zlib.deflateRawSync(entry.content, {level: 9});
        const crc = zipUtils.crc32(entry.content);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic build.
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(entry.content.length, 22);
        local.writeUInt16LE(name.length, 26);
        localRecords.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(entry.content.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(0x20, 38);
        central.writeUInt32LE(offset, 42);
        centralRecords.push(central, name);
        offset += local.length + name.length + compressed.length;
    }
    const centralData = Buffer.concat(centralRecords);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralData.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localRecords, centralData, end]);
}

const entries = [];
const files = [];
let unchanged = 0;
for (const file of walk(cnRoot)) {
    if (['.DS_Store', 'Thumbs.db'].includes(path.basename(file))) continue;
    const relative = path.relative(cnRoot, file).split(path.sep).join('/');
    const content = fs.readFileSync(file);
    const originalFile = path.join(originalRoot, relative);
    const original = fs.existsSync(originalFile) ? fs.readFileSync(originalFile) : null;
    if (original && original.equals(content)) {
        unchanged++;
        continue;
    }
    entries.push({path: relative, content});
    files.push({path: relative, bytes: content.length, sha256: sha256(content),
        originalSha256: original ? sha256(original) : null});
}
if (!files.length) throw new Error('No translated resources found.');
const patch = makeZip(entries);

// Verify every entry with the original game's ZIP decoder before writing.
const readback = new AdmZip(patch);
if (readback.getEntries().length !== files.length) throw new Error('ZIP entry count mismatch.');
for (const file of files) {
    const data = readback.readFile(file.path);
    if (!Buffer.isBuffer(data) || sha256(data) !== file.sha256) {
        throw new Error('ZIP content mismatch: ' + file.path);
    }
}
fs.mkdirSync(outputRoot, {recursive: true});
fs.writeFileSync(path.join(outputRoot, '01.tpatch'), patch);
const manifest = {
    patch: '01.tpatch', projectID,
    sourceExeSha256: sha256(fs.readFileSync(path.join(root, 'SOURCE/otokonoko.exe'))),
    patchSha256: sha256(patch), patchBytes: patch.length,
    uncompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    filesIncluded: files.length, unchangedFilesOmitted: unchanged, files
};
fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({patch: path.join(outputRoot, '01.tpatch'),
    bytes: manifest.patchBytes, files: files.length, sha256: manifest.patchSha256}, null, 2));
