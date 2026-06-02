import { access, appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./store.js";
import { readEpub } from "./import-epub.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const booksDir = path.join(dataDir, "books");
const uploadsDir = path.join(dataDir, "uploads");
const maxImportBytes = Number(process.env.READING_IMPORT_MAX_BYTES || 25_000_000);
const uploadSessions = new Map();
let importQueue = Promise.resolve();
const STALE_UPLOAD_MS = 60 * 60 * 1000; // 1 hour

async function cleanupStaleUploads() {
  try {
    const entries = await readdir(uploadsDir).catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
      const dir = path.join(uploadsDir, entry);
      try {
        const info = await stat(dir);
        if (info.isDirectory() && now - info.mtimeMs > STALE_UPLOAD_MS) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch { /* ignore per-entry errors */ }
    }
  } catch { /* uploads dir may not exist yet */ }
}

cleanupStaleUploads();

function withImportLock(operation) {
  const run = importQueue.then(operation, operation);
  importQueue = run.catch(() => {});
  return run;
}

function resolveInside(baseDir, ...parts) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...parts);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Path escapes import directory: ${parts.join("/")}`);
}

function safeBookId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = String(value).trim();
  if (!/^[A-Za-z0-9._\-\u4e00-\u9fff]+$/u.test(id) || id.includes("..")) {
    throw new Error("bookId may only contain letters, numbers, CJK characters, dot, dash, or underscore");
  }
  return id;
}

const MAX_HEADING_REGEX_LENGTH = 200;

function validateHeadingRegex(value) {
  if (!value) return null;
  const regex = String(value);
  if (regex.length > MAX_HEADING_REGEX_LENGTH) {
    throw new Error(`headingRegex exceeds ${MAX_HEADING_REGEX_LENGTH} characters`);
  }
  return regex;
}

function extensionFormat(filename, format) {
  const explicit = format ? String(format).toLowerCase().replace(/^\./, "") : "";
  if (["txt", "text", "md", "markdown"].includes(explicit)) return "txt";
  if (explicit === "epub") return "epub";

  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".epub") return "epub";
  if ([".txt", ".text", ".md", ".markdown"].includes(ext)) return "txt";
  throw new Error("Unsupported import format. Use EPUB or TXT.");
}

function safeFilename(filename, format) {
  const fallback = format === "epub" ? "upload.epub" : "upload.txt";
  const base = path.basename(String(filename || fallback)).replace(/[^\w.\-\u4e00-\u9fff ]+/gu, "_");
  const trimmed = base.trim().replace(/^\.+/, "");
  return trimmed || fallback;
}

function titleFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename)).trim();
  return stem || "Imported Book";
}

function positiveInteger(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function normalizeBase64(value) {
  if (!value || typeof value !== "string") throw new Error("dataBase64 is required");
  const body = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  return body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
}

function decodeBase64(value) {
  const normalized = normalizeBase64(value);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("dataBase64 is not valid base64");
  }
  return Buffer.from(normalized, "base64");
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function commonOptions(input = {}) {
  return {
    filename: safeFilename(input.filename, extensionFormat(input.filename, input.format)),
    format: extensionFormat(input.filename, input.format),
    bookId: safeBookId(input.bookId),
    title: input.title ? String(input.title) : null,
    author: input.author ? String(input.author) : null,
    maxChars: positiveInteger(input.maxChars, "maxChars"),
    headingRegex: validateHeadingRegex(input.headingRegex),
    minSectionChars: positiveInteger(input.minSectionChars, "minSectionChars"),
    overwrite: input.overwrite === true,
  };
}

async function prepareTarget(options) {
  await mkdir(booksDir, { recursive: true });
  if (!options.bookId) return;

  const target = resolveInside(booksDir, options.bookId);
  if (!(await exists(target))) return;
  if (!options.overwrite) {
    throw new Error(`Book already exists: ${options.bookId}. Pass overwrite: true to replace it.`);
  }
  await rm(target, { recursive: true, force: true });
}

// ─── Pure JS text import (replaces scripts/import_text.py) ─────────

function slugify(value) {
  let s = value.trim().toLowerCase();
  s = s.replace(/[^\w\u4e00-\u9fff]+/gu, "-");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "book";
}

function countWords(text) {
  const words = text.match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]/g);
  return words ? words.length : 0;
}

function isSemanticBreak(prev, current) {
  const breakMarkers = new Set(["***", "---", "* * *", "\u25C6", "\u25A0", "\u25CF", "\u25CB", "\u2606"]);
  if (breakMarkers.has(prev.trim()) || breakMarkers.has(current.trim())) return true;
  if (prev.trim().length < 20 && /^\d+$/.test(prev.trim())) return true;
  return /[。.]"?\s*$|[？?]"?\s*$|[！!]"?\s*$/.test(prev);
}

function splitText(text, maxChars) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return [text.trim()];
  if (paragraphs.reduce((sum, p) => sum + p.length + 2, 0) <= maxChars) {
    return [paragraphs.join("\n\n")];
  }

  const chunks = [];
  let start = 0;

  while (start < paragraphs.length) {
    let currentLen = 0;
    let end = start;

    while (end < paragraphs.length) {
      const pLen = paragraphs[end].length + 2;
      if (currentLen + pLen > maxChars && end > start) break;
      currentLen += pLen;
      end++;
    }

    if (end >= paragraphs.length) {
      chunks.push(paragraphs.slice(start).join("\n\n"));
      break;
    }

    const searchStart = Math.max(start + 1, end - 5);
    const searchEnd = Math.min(paragraphs.length, end + 3);
    let bestCut = end;
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      if (isSemanticBreak(paragraphs[i - 1], paragraphs[i])) {
        bestCut = i;
        break;
      }
    }

    chunks.push(paragraphs.slice(start, bestCut).join("\n\n"));
    start = bestCut;
  }

  return chunks.length ? chunks : [text.trim()];
}

function sectionsFromHeadingRegex(text, headingRegex, minSectionChars = 1) {
  const pattern = new RegExp(headingRegex, "gm");
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return [];

  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const sectionText = text.slice(start, end).trim();
    const title = matches[i][1]?.trim() || matches[i][0].trim();
    if (sectionText && sectionText.length >= minSectionChars) {
      sections.push({ title, text: sectionText });
    }
  }
  return sections;
}

function chunkId(index) {
  return `ch${String(index).padStart(2, "0")}`;
}

async function writeBookSections(sections, title, author, bookId, maxChars, source = null) {
  const resolvedBookId = bookId || slugify(title);
  const bookDir = path.join(booksDir, resolvedBookId);
  const chunksDir = path.join(bookDir, "chunks");
  await mkdir(chunksDir, { recursive: true });

  const plannedChunks = [];
  for (let si = 0; si < sections.length; si++) {
    const sectionTitle = sections[si].title || `Section ${si + 1}`;
    const sectionText = sections[si].text || "";
    const sectionChunks = splitText(sectionText, maxChars);
    for (let pi = 0; pi < sectionChunks.length; pi++) {
      const partCount = sectionChunks.length;
      const displayTitle = partCount === 1 ? sectionTitle : `${sectionTitle} Part ${pi + 1}/${partCount}`;
      plannedChunks.push({
        text: sectionChunks[pi],
        title: displayTitle,
        sectionTitle,
        sectionIndex: si,
        sectionPart: pi + 1,
        sectionPartCount: partCount,
        sourcePath: sections[si].sourcePath || null,
      });
    }
  }

  const manifestChunks = [];
  for (let i = 0; i < plannedChunks.length; i++) {
    const cid = chunkId(i);
    const chunkText = plannedChunks[i].text;
    const chunkPath = path.join(chunksDir, `${cid}.txt`);
    await writeFile(chunkPath, `# ${plannedChunks[i].title}\n\n${chunkText.trim()}\n`, "utf8");
    manifestChunks.push({
      id: cid,
      title: plannedChunks[i].title,
      sectionTitle: plannedChunks[i].sectionTitle,
      sectionIndex: plannedChunks[i].sectionIndex,
      sectionPart: plannedChunks[i].sectionPart,
      sectionPartCount: plannedChunks[i].sectionPartCount,
      sourcePath: plannedChunks[i].sourcePath,
      order: i,
      path: `chunks/${cid}.txt`,
      charCount: chunkText.length,
      wordCount: countWords(chunkText),
      prevId: i > 0 ? chunkId(i - 1) : null,
      nextId: i < plannedChunks.length - 1 ? chunkId(i + 1) : null,
    });
  }

  const manifest = {
    bookId: resolvedBookId,
    title,
    author: author || null,
    language: null,
    createdAt: new Date().toISOString(),
    source: source || { type: "text" },
    chunks: manifestChunks,
  };
  await writeFile(path.join(bookDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return bookDir;
}

async function importText(buffer, options) {
  const text = buffer.toString("utf-8");
  const title = options.title || titleFromFilename(options.filename);
  let sections;

  if (options.headingRegex) {
    sections = sectionsFromHeadingRegex(text, options.headingRegex, options.minSectionChars || 1);
  }

  if (sections && sections.length) {
    await writeBookSections(sections, title, options.author, options.bookId, options.maxChars || 6000, {
      type: "text",
      headingRegex: options.headingRegex,
      minSectionChars: options.minSectionChars || 1,
    });
  } else {
    await writeBookSections(
      [{ title, text, sourcePath: null }],
      title,
      options.author,
      options.bookId,
      options.maxChars || 6000,
      { type: "text" },
    );
  }

  const bookDir = path.join(booksDir, options.bookId || slugify(title));
  return JSON.parse(await readFile(path.join(bookDir, "manifest.json"), "utf8"));
}

async function importEpubFromBuffer(buffer, options) {
  const { title: epubTitle, author: epubAuthor, sections, fileName } = await readEpub(buffer, options.filename);
  const finalTitle = options.title || cleanMetadataTitle(epubTitle, titleFromFilename(options.filename));
  const finalAuthor = options.author || cleanMetadataAuthor(epubAuthor, finalTitle);

  if (!sections.length) throw new Error("No readable text found in EPUB");

  await writeBookSections(sections, finalTitle, finalAuthor, options.bookId, options.maxChars || 6000, {
    type: "epub",
    fileName,
  });

  const bookDir = path.join(booksDir, options.bookId || slugify(finalTitle));
  return JSON.parse(await readFile(path.join(bookDir, "manifest.json"), "utf8"));
}

function cleanMetadataTitle(value, fallback) {
  const t = (value || "").trim();
  if (!t || /^(unknown|untitled|administrator)$/i.test(t) || t.length <= 1) return fallback;
  return t;
}

function cleanMetadataAuthor(value, title) {
  const a = (value || "").trim();
  if (!a || /^(unknown|administrator)$/i.test(a) || a === title) return null;
  return a;
}

async function runImport(filePath, options) {
  await prepareTarget(options);

  const buffer = await readFile(filePath);
  let manifest;

  if (options.format === "epub") {
    manifest = await importEpubFromBuffer(buffer, options);
  } else {
    manifest = await importText(buffer, options);
  }

  const firstChunk = manifest.chunks?.[0] || null;
  const lastChunk = manifest.chunks?.[manifest.chunks.length - 1] || null;
  return {
    bookId: manifest.bookId,
    title: manifest.title,
    author: manifest.author || null,
    chunkCount: manifest.chunks?.length || 0,
    firstChunkId: firstChunk?.id || null,
    lastChunkId: lastChunk?.id || null,
    source: manifest.source || null,
    message: `Imported ${manifest.title} (${manifest.chunks?.length || 0} chunks).`,
  };
}

export function importLimits() {
  return { maxImportBytes };
}

export async function importBook(input = {}) {
  const options = commonOptions(input);
  const buffer = decodeBase64(input.dataBase64);
  if (!buffer.length) throw new Error("Imported file is empty");
  if (buffer.length > maxImportBytes) {
    throw new Error(`Imported file exceeds ${maxImportBytes} bytes`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "co-reading-import-"));
  const filePath = resolveInside(tempDir, options.filename);
  try {
    await writeFile(filePath, buffer);
    return await withImportLock(() => runImport(filePath, options));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function beginImport(input = {}) {
  const options = commonOptions(input);
  const expectedBytes = positiveInteger(input.expectedBytes, "expectedBytes") || null;
  if (expectedBytes && expectedBytes > maxImportBytes) {
    throw new Error(`Imported file exceeds ${maxImportBytes} bytes`);
  }

  const uploadId = crypto.randomUUID();
  const dir = resolveInside(uploadsDir, uploadId);
  await mkdir(dir, { recursive: true });
  const filePath = resolveInside(dir, options.filename);
  await writeFile(filePath, "");
  uploadSessions.set(uploadId, {
    uploadId,
    options,
    filePath,
    dir,
    expectedBytes,
    bytes: 0,
    parts: 0,
    createdAt: new Date().toISOString(),
  });

  return {
    uploadId,
    filename: options.filename,
    format: options.format,
    maxImportBytes,
    expectedBytes,
    message: "Upload started. Send base64 file parts with reading_import_part, then call reading_import_finish.",
  };
}

export async function appendImportPart({ uploadId, dataBase64, index } = {}) {
  return withImportLock(async () => {
    if (!uploadId) throw new Error("uploadId is required");
    const session = uploadSessions.get(uploadId);
    if (!session) throw new Error(`Unknown uploadId: ${uploadId}`);
    if (index !== undefined && Number(index) !== session.parts) {
      throw new Error(`Unexpected part index ${index}; expected ${session.parts}`);
    }

    const buffer = decodeBase64(dataBase64);
    if (!buffer.length) throw new Error("Import part is empty");
    if (session.bytes + buffer.length > maxImportBytes) {
      throw new Error(`Imported file exceeds ${maxImportBytes} bytes`);
    }

    await appendFile(session.filePath, buffer);
    session.bytes += buffer.length;
    session.parts += 1;
    return {
      uploadId,
      bytes: session.bytes,
      parts: session.parts,
      done: false,
    };
  });
}

export async function finishImport({ uploadId } = {}) {
  return withImportLock(async () => {
    if (!uploadId) throw new Error("uploadId is required");
    const session = uploadSessions.get(uploadId);
    if (!session) throw new Error(`Unknown uploadId: ${uploadId}`);

    const info = await stat(session.filePath);
    if (info.size === 0) throw new Error("Imported file is empty");
    if (session.expectedBytes && info.size !== session.expectedBytes) {
      throw new Error(`Uploaded ${info.size} bytes, expected ${session.expectedBytes}`);
    }

    const result = await runImport(session.filePath, session.options);
    uploadSessions.delete(uploadId);
    await rm(session.dir, { recursive: true, force: true });
    return { uploadId, ...result };
  });
}

export async function cancelImport({ uploadId } = {}) {
  return withImportLock(async () => {
    if (!uploadId) throw new Error("uploadId is required");
    const session = uploadSessions.get(uploadId);
    if (!session) return { uploadId, cancelled: false, message: "Upload was already gone." };
    uploadSessions.delete(uploadId);
    await rm(session.dir, { recursive: true, force: true });
    return { uploadId, cancelled: true };
  });
}
