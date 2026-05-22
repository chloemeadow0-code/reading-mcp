import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const dataDir = process.env.READING_MCP_DATA_DIR
  ? path.resolve(process.env.READING_MCP_DATA_DIR)
  : path.join(ROOT, "data");

const booksDir = path.join(dataDir, "books");
const annotationsPath = path.join(dataDir, "annotations.jsonl");
const progressPath = path.join(dataDir, "progress.json");
const sessionsPath = path.join(dataDir, "reading_sessions.json");

const manifestCache = new Map();
const chunkTextCache = new Map();
const annotationCache = {
  signature: null,
  rows: [],
  bookCounts: new Map(),
  chunkCounts: new Map(),
};
let writeQueue = Promise.resolve();

function invalidateAnnotationCache() {
  annotationCache.signature = null;
  annotationCache.rows = [];
  annotationCache.bookCounts = new Map();
  annotationCache.chunkCounts = new Map();
}

async function withWriteLock(operation) {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => {});
  return run;
}

function resolveInside(baseDir, ...parts) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...parts);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Path escapes data directory: ${parts.join("/")}`);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileSignature(filePath) {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, rows) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, body ? `${body}\n` : "", "utf8");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export async function loadManifest(bookId) {
  const manifestPath = resolveInside(booksDir, bookId, "manifest.json");
  const signature = await fileSignature(manifestPath);
  const cached = manifestCache.get(manifestPath);
  if (cached?.signature === signature) return cached.manifest;

  const manifest = await readJson(manifestPath, null);
  if (!manifest) throw new Error(`Unknown bookId: ${bookId}`);
  manifest.chunks = asArray(manifest.chunks);
  manifestCache.set(manifestPath, { signature, manifest });
  return manifest;
}

async function annotationSummary() {
  const signature = await fileSignature(annotationsPath);
  if (annotationCache.signature === signature) {
    return annotationCache;
  }

  const rows = await readAllAnnotations();
  const bookCounts = new Map();
  const chunkCounts = new Map();
  for (const annotation of rows) {
    bookCounts.set(annotation.bookId, (bookCounts.get(annotation.bookId) || 0) + 1);
    const chunkKey = chunkContextKey(annotation.bookId, annotation.chunkId);
    chunkCounts.set(chunkKey, (chunkCounts.get(chunkKey) || 0) + 1);
  }

  annotationCache.signature = signature;
  annotationCache.rows = rows;
  annotationCache.bookCounts = bookCounts;
  annotationCache.chunkCounts = chunkCounts;
  return annotationCache;
}

export async function listBooks() {
  let entries = [];
  try {
    entries = await readdir(booksDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const progress = await loadProgress();
  const annotations = await annotationSummary();

  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await loadManifest(entry.name);
      const readIds = new Set(progress[manifest.bookId]?.readChunkIds || []);
      books.push({
        bookId: manifest.bookId,
        title: manifest.title,
        author: manifest.author || null,
        language: manifest.language || null,
        chunkCount: manifest.chunks.length,
        chunksRead: readIds.size,
        annotationCount: annotations.bookCounts.get(manifest.bookId) || 0,
        lastChunkId: progress[manifest.bookId]?.lastChunkId || null,
        lastReadAt: progress[manifest.bookId]?.lastReadAt || null,
      });
    } catch {
      // Ignore broken book folders, but keep the server usable.
    }
  }
  return books.sort((a, b) => a.title.localeCompare(b.title));
}

export async function listChunks(bookId) {
  const manifest = await loadManifest(bookId);
  const progress = await loadProgress();
  const readIds = new Set(progress[bookId]?.readChunkIds || []);
  const annotations = await annotationSummary();

  return manifest.chunks
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((chunk) => ({
      ...chunk,
      read: readIds.has(chunk.id),
      annotationCount: annotations.chunkCounts.get(chunkContextKey(bookId, chunk.id)) || 0,
    }));
}

export async function readChunk(bookId, chunkId) {
  const manifest = await loadManifest(bookId);
  const chunk = manifest.chunks.find((item) => item.id === chunkId);
  if (!chunk) throw new Error(`Unknown chunkId for ${bookId}: ${chunkId}`);
  const bookDir = resolveInside(booksDir, bookId);
  const chunkPath = resolveInside(bookDir, chunk.path);
  const signature = await fileSignature(chunkPath);
  const cached = chunkTextCache.get(chunkPath);
  let text = cached?.signature === signature ? cached.text : null;
  if (text === null) {
    text = await readFile(chunkPath, "utf8");
    chunkTextCache.set(chunkPath, { signature, text });
  }
  return {
    bookId,
    title: manifest.title,
    author: manifest.author || null,
    chunk,
    prevId: chunk.prevId ?? null,
    nextId: chunk.nextId ?? null,
    text,
  };
}

export async function searchChunks({ bookId, query, limit = 10 }) {
  if (!query || !query.trim()) throw new Error("query is required");
  const books = bookId ? [{ bookId }] : await listBooks();
  const results = [];
  const needle = query.toLocaleLowerCase();

  for (const book of books) {
    const id = book.bookId;
    const chunks = await listChunks(id);
    for (const chunk of chunks) {
      const text = (await readChunk(id, chunk.id)).text;
      const haystack = text.toLocaleLowerCase();
      const index = haystack.indexOf(needle);
      if (index === -1) continue;
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + query.length + 120);
      results.push({
        bookId: id,
        chunkId: chunk.id,
        title: chunk.title,
        offset: index,
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export async function loadProgress() {
  return readJson(progressPath, {});
}

async function loadSessionLedger() {
  const ledger = await readJson(sessionsPath, { sessions: {} });
  ledger.sessions ||= {};
  return ledger;
}

async function saveSessionLedger(ledger) {
  await writeJson(sessionsPath, ledger);
}

function chunkContextKey(bookId, chunkId) {
  return `${bookId}/${chunkId}`;
}

async function buildSubmissionContext(notes, options = {}) {
  const sessionId = options.sessionId || "default";
  const includeContext = options.includeContext !== false;
  const forceChunkContext = options.forceChunkContext === true;
  const contextMode = options.contextMode || "chunk-once-per-session";
  const submittedAt = options.submittedAt || new Date().toISOString();
  const ledger = await loadSessionLedger();
  const session = ledger.sessions[sessionId] || { chunks: {}, annotations: {} };
  ledger.sessions[sessionId] = session;
  session.chunks ||= {};
  session.annotations ||= {};

  const chunks = [];
  const omittedChunks = [];
  const seenChunkKeys = new Set();

  if (includeContext) {
    for (const note of notes) {
      const key = chunkContextKey(note.bookId, note.chunkId);
      if (seenChunkKeys.has(key)) continue;
      seenChunkKeys.add(key);

      if (contextMode === "notes-only") {
        omittedChunks.push({
          bookId: note.bookId,
          chunkId: note.chunkId,
          reason: "notes-only",
          sentAt: null,
        });
        continue;
      }

      const sentBefore = Boolean(session.chunks[key]);
      const shouldInclude =
        contextMode === "chunk-always" ||
        forceChunkContext ||
        (contextMode === "chunk-once-per-session" && !sentBefore);

      if (!shouldInclude) {
        omittedChunks.push({
          bookId: note.bookId,
          chunkId: note.chunkId,
          reason: "already-sent-in-session",
          sentAt: session.chunks[key]?.sentAt || null,
        });
        continue;
      }

      const chunk = await readChunk(note.bookId, note.chunkId);
      chunks.push({
        bookId: note.bookId,
        chunkId: note.chunkId,
        title: chunk.chunk.title,
        bookTitle: chunk.title,
        author: chunk.author,
        prevId: chunk.prevId,
        nextId: chunk.nextId,
        text: chunk.text,
      });
      session.chunks[key] = {
        bookId: note.bookId,
        chunkId: note.chunkId,
        sentAt: submittedAt,
        contextMode,
      };
    }
  }

  for (const note of notes) {
    session.annotations[note.id] = {
      bookId: note.bookId,
      chunkId: note.chunkId,
      submittedAt,
    };
  }

  return {
    sessionId,
    contextMode,
    chunks,
    omittedChunks,
    noteCount: notes.length,
    ledger,
  };
}

export async function markRead(bookId, chunkId) {
  return withWriteLock(async () => {
    const manifest = await loadManifest(bookId);
    if (!manifest.chunks.some((chunk) => chunk.id === chunkId)) {
      throw new Error(`Unknown chunkId for ${bookId}: ${chunkId}`);
    }
    const progress = await loadProgress();
    const current = progress[bookId] || {};
    const readIds = new Set(current.readChunkIds || []);
    readIds.add(chunkId);
    progress[bookId] = {
      lastChunkId: chunkId,
      lastReadAt: new Date().toISOString(),
      readChunkIds: Array.from(readIds),
    };
    await writeJson(progressPath, progress);
    return progress[bookId];
  });
}

async function readAllAnnotations() {
  let raw = "";
  try {
    raw = await readFile(annotationsPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return raw
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function listAnnotations({ bookId, chunkId, kind, author, status, parentId } = {}) {
  const annotations = await annotationSummary();
  return annotations.rows
    .filter((item) => !bookId || item.bookId === bookId)
    .filter((item) => !chunkId || item.chunkId === chunkId)
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => !author || item.author === author)
    .filter((item) => !status || (item.status || "published") === status)
    .filter((item) => parentId === undefined || (item.parentId || null) === parentId);
}

export async function annotatePassage(input) {
  return withWriteLock(async () => {
    const { bookId, chunkId, quote, note } = input;
    if (!bookId) throw new Error("bookId is required");
    if (!chunkId) throw new Error("chunkId is required");
    if (!quote) throw new Error("quote is required");
    if (!note) throw new Error("note is required");

    const chunk = await readChunk(bookId, chunkId);
    const quoteOffset = chunk.text.indexOf(quote);
    const author = input.author || "claude";
    const annotation = {
      id: `ann_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      bookId,
      chunkId,
      quote,
      note,
      author,
      kind: input.kind || "annotation",
      mood: input.mood || null,
      tags: Array.isArray(input.tags) ? input.tags : [],
      status: input.status || (author === "user" ? "open" : "published"),
      parentId: input.parentId || null,
      quoteOffset: quoteOffset >= 0 ? quoteOffset : null,
      prevId: chunk.prevId,
      nextId: chunk.nextId,
      createdAt: new Date().toISOString(),
    };

    await mkdir(dataDir, { recursive: true });
    await appendFile(annotationsPath, `${JSON.stringify(annotation)}\n`, "utf8");
    invalidateAnnotationCache();
    return annotation;
  });
}

export async function submitUserNotes({
  bookId,
  chunkId,
  sessionId = "default",
  contextMode = "chunk-once-per-session",
  includeContext = true,
  forceChunkContext = false,
} = {}) {
  return withWriteLock(async () => {
    const annotations = await readAllAnnotations();
    const submittedAt = new Date().toISOString();
    const submitted = [];
    const updated = annotations.map((annotation) => {
      const status = annotation.status || "published";
      const shouldSubmit =
        annotation.author === "user" &&
        status === "open" &&
        (!bookId || annotation.bookId === bookId) &&
        (!chunkId || annotation.chunkId === chunkId);

      if (!shouldSubmit) return annotation;

      const next = { ...annotation, status: "submitted", submittedAt };
      submitted.push(next);
      return next;
    });

    const context = await buildSubmissionContext(submitted, {
      sessionId,
      contextMode,
      includeContext,
      forceChunkContext,
      submittedAt,
    });
    const ledger = context.ledger;
    delete context.ledger;

    if (submitted.length > 0) {
      await writeJsonl(annotationsPath, updated);
      invalidateAnnotationCache();
      try {
        await saveSessionLedger(ledger);
      } catch (error) {
        await writeJsonl(annotationsPath, annotations);
        invalidateAnnotationCache();
        throw error;
      }
    }

    return {
      submittedAt,
      sessionId,
      count: submitted.length,
      notes: submitted,
      context,
      message:
        submitted.length === 0
          ? "No open user notes to submit."
          : "Submitted user notes have been marked submitted. Chunk text is included once per session by default.",
    };
  });
}

export async function replyToAnnotation(input) {
  const { parentId, note } = input;
  if (!parentId) throw new Error("parentId is required");
  if (!note) throw new Error("note is required");

  const parent = (await readAllAnnotations()).find((annotation) => annotation.id === parentId);
  if (!parent) throw new Error(`Unknown parent annotation: ${parentId}`);

  return annotatePassage({
    bookId: input.bookId || parent.bookId,
    chunkId: input.chunkId || parent.chunkId,
    quote: input.quote || parent.quote,
    note,
    author: input.author || "claude",
    kind: input.kind || "reply",
    mood: input.mood || null,
    tags: input.tags || [],
    parentId,
    status: "published",
  });
}

export async function getProgress(bookId) {
  const progress = await loadProgress();
  return bookId ? progress[bookId] || null : progress;
}
