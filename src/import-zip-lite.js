/**
 * Minimal ZIP reader for EPUB files.
 * No external dependencies — reads Central Directory directly.
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export class ZipReader {
  constructor(buffer) {
    if (Buffer.isBuffer(buffer)) {
      this.buf = buffer;
    } else {
      this.buf = Buffer.from(buffer);
    }
    this._entries = this._readCentralDirectory();
  }

  get entryNames() {
    return this._entries.map((e) => e.fileName);
  }

  async readEntry(name) {
    const entry = this._entries.find((e) => e.fileName === name);
    if (!entry) return null;
    return this._inflateEntry(entry);
  }

  _inflateEntry(entry) {
    const { offset, compressedSize, uncompressedSize, method } = entry;
    const compressed = this.buf.subarray(offset, offset + compressedSize);

    if (method === 0) {
      // Stored (no compression)
      return compressed;
    }

    if (method === 8) {
      // Deflate
      return inflateRawSync(compressed);
    }

    throw new Error(`Unsupported ZIP compression method: ${method}`);
  }

  _readCentralDirectory() {
    const buf = this.buf;
    const len = buf.length;

    // Find End of Central Directory record (scan backwards)
    let eocdOffset = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("Not a valid ZIP file: EOCD not found");

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdEntries = buf.readUInt16LE(eocdOffset + 10);

    const entries = [];
    let pos = cdOffset;

    for (let i = 0; i < cdEntries; i++) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) break;

      const method = buf.readUInt16LE(pos + 10);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const uncompressedSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localHeaderOffset = buf.readUInt32LE(pos + 42);

      const fileName = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8");

      // Read local file header to get actual data offset
      const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

      entries.push({
        fileName,
        method,
        compressedSize,
        uncompressedSize,
        offset: dataOffset,
      });

      pos += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }
}
