/**
 * Minimal XML-to-JSON parser for EPUB/OPF.
 * No external dependencies — pure Node.js.
 * Output format compatible with xml2js compact mode: { tag: { $: {attr}, _: "text", child: [...] } }
 */

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, name) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return NAMED[name] || m;
  });
}

function isWhitespace(s) {
  return /^\s*$/.test(s);
}

function parseXml(xml) {
  // Strip BOM and XML declaration
  xml = xml.replace(/^\uFEFF/, "").replace(/<\?xml[^?]*\?>/g, "");

  const stack = [];
  let root = null;

  const tagRe = /<(\/?)([a-zA-Z_:][\w:.\-]*)([^>]*?)(\/?)>/gs;

  let lastIdx = 0;
  let match;

  while ((match = tagRe.exec(xml)) !== null) {
    const [full, isClosing, tagName, attrStr, isSelfClosing] = match;
    const textBetween = xml.slice(lastIdx, match.index);
    lastIdx = tagRe.lastIndex;

    // Text node
    if (textBetween && !isWhitespace(textBetween) && stack.length) {
      const parent = stack[stack.length - 1];
      appendText(parent, decodeEntities(textBetween));
    }

    if (isClosing) {
      // Closing tag
      if (stack.length) stack.pop();
      continue;
    }

    // Opening tag
    const attrs = parseAttrs(attrStr);
    const node = { $: attrs };

    if (isSelfClosing) {
      // Self-closing
      if (stack.length) {
        appendChild(stack[stack.length - 1], tagName, node);
      } else {
        root = root || {};
        appendChild(root, tagName, node);
      }
    } else {
      stack.push({ tagName, node });
    }
  }

  // Remaining text
  const remaining = xml.slice(lastIdx);
  if (remaining && !isWhitespace(remaining) && stack.length) {
    appendText(stack[stack.length - 1].node, decodeEntities(remaining));
  }

  // Close unclosed tags
  while (stack.length) {
    const { tagName, node } = stack.pop();
    if (stack.length) {
      appendChild(stack[stack.length - 1].node, tagName, node);
    } else {
      root = root || {};
      appendChild(root, tagName, node);
    }
  }

  return root;
}

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

function appendChild(parent, tagName, node) {
  if (parent[tagName]) {
    if (!Array.isArray(parent[tagName])) {
      parent[tagName] = [parent[tagName]];
    }
    parent[tagName].push(node);
  } else {
    parent[tagName] = node;
  }
}

function appendText(parent, text) {
  if (parent._) {
    parent._ += text;
  } else {
    parent._ = text;
  }
}

export function parseStringPromise(xmlString) {
  return new Promise((resolve, reject) => {
    try {
      const result = parseXml(typeof xmlString === "string" ? xmlString : xmlString.toString("utf-8"));
      resolve(result || {});
    } catch (err) {
      reject(err);
    }
  });
}

export { parseXml };
