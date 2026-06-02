/**
 * Minimal XML parser for EPUB/OPF parsing.
 * Uses Node.js built-in, no external dependencies.
 */

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "