#!/usr/bin/env node
/**
 * Pure-JS EPUB import for Co-Reading MCP.
 * Replaces scripts/import_epub.py — no Python3 dependency needed.
 */

import { createUnzip } from "node:zlib";
import { basename, dirname, join, relative } from "node:path";
import { parseStringPromise } from "./import-xml-lite.js";

// ─── helpers ──────────────────────────────────────────────────────

function nsName(tag) {
  const idx = tag.indexOf("}");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function stripTags(raw) {
  let s = raw.replace(/<[^>]+>/gis, " ");
  s = unescapeHtml(s);
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0" };
function unescapeHtml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([A-Za-z]+);/g, (_, name) => HTML_ENTITIES[name] || `&${name};`);
}

function titleFromHtml(raw) {
  for (const m of raw.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gis)) {
    const t = stripTags(m[1]);
    if (t) return t;
  }
  const tm = raw.match(/<title[^>]*>(.*?)<\/title>/is);
  if (tm) {
    const t = stripTags(tm[1]);
    if (t) return t;
  }
  return null;
}

function textFromHtml(raw) {
  let s = raw.replace(/<(script|style)[^>]*>.*?<\/\1>/gis, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/gis, " ");
  s = unescapeHtml(s);
  s = s.replace(/[ \t\r\f\v]+/g, " ");
  s = s.replace(/\n\s*\n\s*\n+/g, "\n\n");
  return s.trim();
}

function sectionsFromHtmlHeadings(raw) {
  const matches = [...raw.matchAll(/<h[1-3][^>]*>.*?<\/h[1-3]>/gis)];
  if (matches.length < 2) return [];
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const title = stripTags(matches[i][0]) || `Section ${i + 1}`;
    const text = textFromHtml(raw.slice(start, end));
    if (text) sections.push({ title, text });
  }
  return sections;
}

function shouldSplitHtmlByHeadings(raw, text, orderedCount) {
  const sections = sectionsFromHtmlHeadings(raw);
  return sections.length >= 2 && (orderedCount === 1 || text.length > 12000);
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

// ─── EPUB zip helpers ─────────────────────────────────────────────

async function readZipEntries(buffer) {
  // Use dynamic import for JSZip-like manual parsing
  // We'll use the built-in zlib + a minimal central directory reader
  const { ZipReader } = await import("./import-zip-lite.js");
  const reader = new ZipReader(buffer);
  return reader;
}

// ─── OPF / TOC parsing ────────────────────────────────────────────

async function findOpfPath(zip) {
  const raw = await zip.readEntry("META-INF/container.xml");
  if (!raw) return null;
  try {
    const root = await parseStringPromise(raw);
    const rootfiles = findElements(root, "rootfile");
    for (const rf of rootfiles) {
      const fp = rf.$?.["full-path"] || rf.$?.["fullPath"];
      if (fp) return fp;
    }
  } catch { /* ignore parse errors */ }
  return null;
}

function findElements(obj, localName, results = []) {
  if (!obj || typeof obj !== "object") return results;
  for (const key of Object.keys(obj)) {
    if (key === "$" || key === "_") continue;
    const tag = nsName(key);
    if (tag === localName) {
      const items = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
      results.push(...items);
    } else {
      const items = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
      for (const item of items) {
        if (item && typeof item === "object") findElements(item, localName, results);
      }
    }
  }
  return results;
}

function getTextContent(obj) {
  if (typeof obj === "string") return obj.trim();
  if (obj && obj._) return String(obj._).trim();
  if (Array.isArray(obj)) return obj.map(getTextContent).join("").trim();
  return "";
}

async function parseOpf(zip, opfPath) {
  const raw = await zip.readEntry(opfPath);
  if (!raw) return { title: null, author: null, ordered: [], tocTitles: {} };

  let root;
  try {
    root = await parseStringPromise(raw);
  } catch { return { title: null, author: null, ordered: [], tocTitles: {} }; }

  const opfDir = dirname(opfPath) === "." ? "" : dirname(opfPath);
  let title = null;
  let author = null;
  const manifest = {};
  const spineIds = [];
  let tocPath = null;

  const titles = findElements(root, "title");
  if (titles.length && titles[0]) title = getTextContent(titles[0]) || null;

  const creators = findElements(root, "creator");
  if (creators.length && creators[0]) author = getTextContent(creators[0]) || null;

  const items = findElements(root, "item");
  for (const item of items) {
    const id = item.$?.id;
    const href = item.$?.href;
    const mediaType = item.$?.["media-type"] || "";
    const properties = item.$?.properties || "";
    if (id && href && (mediaType.includes("html") || /\.(html?|xhtml)$/i.test(href))) {
      manifest[id] = opfDir ? join(opfDir, href) : href;
    }
    if (href && (properties.split(/\s+/).includes("nav") || mediaType === "application/x-dtbncx+xml")) {
      tocPath = opfDir ? join(opfDir, href) : href;
    }
  }

  const itemrefs = findElements(root, "itemref");
  for (const ir of itemrefs) {
    const idref = ir.$?.idref;
    if (idref) spineIds.push(idref);
  }

  const ordered = spineIds.map((id) => manifest[id]).filter(Boolean);
  const tocTitles = tocPath ? await parseTocTitles(zip, tocPath, opfDir) : {};
  return { title, author, ordered, tocTitles };
}

async function parseTocTitles(zip, tocPath, opfDir) {
  let raw;
  try {
    raw = await zip.readEntry(tocPath);
  } catch { return {}; }
  if (!raw) return {};

  const titles = {};
  let root;
  try {
    root = await parseStringPromise(raw);
  } catch { return titles; }

  function normalizeHref(href) {
    const [path] = href.split("#", 1);
    if (!path) return path;
    return opfDir && !path.startsWith(opfDir) ? join(opfDir, path) : path;
  }

  // NCX navPoints
  const navPoints = findElements(root, "navPoint");
  for (const np of navPoints) {
    let label = null;
    let src = null;
    const texts = findElements(np, "text");
    if (texts.length && texts[0]) label = getTextContent(texts[0]);
    const contents = findElements(np, "content");
    if (contents.length && contents[0]) src = contents[0].$?.src;
    if (label && src) titles[normalizeHref(src)] = label;
  }

  // HTML nav TOC (EPUB3)
  const anchors = findElements(root, "a");
  for (const a of anchors) {
    const href = a.$?.href;
    const text = getTextContent(a);
    if (href && text) titles[normalizeHref(href)] = text;
  }

  return titles;
}

function htmlFileNames(entryNames) {
  return entryNames
    .filter((n) => /\.(html?|xhtml)$/i.test(n) && !n.endsWith("/"))
    .sort();
}

// ─── main read ────────────────────────────────────────────────────

export async function readEpub(buffer, filename = "upload.epub") {
  const zip = await readZipEntries(buffer);

  const opfPath = await findOpfPath(zip);
  let title = null;
  let author = null;
  let ordered = [];
  let tocTitles = {};

  if (opfPath) {
    try {
      ({ title, author, ordered, tocTitles } = await parseOpf(zip, opfPath));
    } catch { ordered = []; }
  }

  if (!ordered.length) {
    ordered = htmlFileNames(zip.entryNames);
  }

  const sections = [];
  for (let i = 0; i < ordered.length; i++) {
    const name = ordered[i];
    let raw;
    try {
      raw = await zip.readEntry(name);
      if (raw) raw = raw.toString("utf-8");
    } catch { continue; }
    if (!raw) continue;

    const text = textFromHtml(raw);
    if (shouldSplitHtmlByHeadings(raw, text, ordered.length)) {
      const headingSections = sectionsFromHtmlHeadings(raw);
      for (let si = 0; si < headingSections.length; si++) {
        sections.push({
          title: headingSections[si].title,
          text: headingSections[si].text,
          sourcePath: `${name}#heading-${si + 1}`,
        });
      }
      continue;
    }
    if (text) {
      const sectionTitle = tocTitles[name] || titleFromHtml(raw) || `Section ${i + 1}`;
      sections.push({ title: sectionTitle, text, sourcePath: name });
    }
  }

  return { title, author, sections, fileName: basename(filename) };
}
