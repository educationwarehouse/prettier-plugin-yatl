"use strict";
/**
 * prettier-plugin-yatl
 * =====================
 * Makes Prettier's HTML formatter treat YATL template delimiters
 * ([[ ... ]] and {{ ... }}) as atomic tokens, so it reflows text content
 * normally but never inserts a line break *inside* a delimiter pair --
 * unlike stock Prettier, which has no concept of YATL syntax and will
 * happily break in the middle of e.g. `[[if x == "y":]]`.
 *
 * Delimiter matching intentionally mirrors YATL's own parser exactly
 * (non-greedy `.*?` between literal delimiters, see web2py/yatl's
 * TemplateParser: `compile("({}.*?{})".format(*escaped_delimiters))`).
 * That parser does NOT handle nested brackets inside a tag body either
 * (e.g. `[[=data['key'][0]]]` already misparses in real YATL) -- this
 * plugin is deliberately bug-compatible with that, not "smarter" than
 * the engine that will actually execute the template.
 *
 * HOW THIS WORKS
 * --------------
 * Prettier's built-in HTML printer decides where text can wrap inside
 * `printer-html.js`'s `case "text":` branch, via a helper called
 * `getTextValueParts()` which (for ordinary, non-whitespace-sensitive
 * content) does exactly this:
 *
 *     join(line, htmlWhitespace.split(value))
 *
 * i.e. split the text on runs of ASCII whitespace, and let any of those
 * splits become a line break. That whitespace-split has zero awareness
 * of `[[ ]]`/`{{ }}`, which is the entire bug.
 *
 * This plugin registers its own parser (astFormat "yatl-html") wrapping
 * Prettier's real HTML parser unchanged, and its own printer that:
 *   - delegates EVERY node to the real, built-in HTML printer, UNCHANGED,
 *     except
 *   - for "text" nodes whose value contains a YATL delimiter and whose
 *     parent isn't whitespace-sensitive (pre/textarea are already safe,
 *     untouched -- they don't call the whitespace-splitter at all),
 *     where it reimplements that one branch with a whitespace-splitter
 *     that treats a whole `[[...]]`/`{{...}}` span as a single word.
 *
 * The surrounding tag-boundary "does this text borrow whitespace from
 * its neighbouring tag" logic (prefix/suffix handling -- e.g. deciding
 * whether `<b>foo</b> <i>bar</i>` keeps that middle space) is NOT part
 * of Prettier's public plugin API, so the relevant functions from
 * Prettier's `src/language-html/print/tag.js` are vendored below
 * (adapted only to import from the public `prettier/doc` entrypoint and
 * to drop Vue/Angular-specific branches, which never apply to a plain
 * ".html" parse). This is real, but narrow, coupling to Prettier's
 * internals: they are not part of its public API, so a future Prettier
 * version could change this behavior without it showing up as a broken
 * import -- only as a formatting regression. Re-run this plugin's test
 * fixtures after bumping the `prettier` version to catch that.
 *
 * Source lifted from: https://github.com/prettier/prettier
 *   src/language-html/printer-html.js  (the "text" case)
 *   src/language-html/print/tag.js     (prefix/suffix + marker functions)
 *   src/language-html/utilities/index.js (small supporting predicates)
 * as of prettier@3.9.6, MIT licensed.
 */

const htmlPlugin = require("prettier/plugins/html");
const { builders } = require("prettier/doc");
const { line, hardline, fill } = builders;

// ---------------------------------------------------------------------
// YATL delimiter matching -- bug-compatible with yatl/template.py's own
// `compile("({}.*?{})".format(*escaped_delimiters))`.
// ---------------------------------------------------------------------

const YATL_TAG_RE_G = /\[\[.*?\]\]|\{\{.*?\}\}/gs;
const YATL_TAG_RE = /\[\[.*?\]\]|\{\{.*?\}\}/s;

function containsYatlTag(text) {
  return YATL_TAG_RE.test(text);
}

// Mask whitespace *inside* YATL spans with non-whitespace sentinels so
// `HTML_WS_SPLIT_RE` (identical to Prettier's own htmlWhitespace pattern)
// can never split there, then restore the exact original characters
// afterwards. Each ASCII-whitespace kind gets its own sentinel so this
// is fully lossless (not just "collapsed to a plain space").
const WS_TO_SENTINEL = { "\t": "\u0001", "\n": "\u0002", "\f": "\u0003", "\r": "\u0004", " ": "\u0005" };
const SENTINEL_TO_WS = Object.fromEntries(Object.entries(WS_TO_SENTINEL).map(([k, v]) => [v, k]));
const WS_CHARS_RE = /[\t\n\f\r ]/g;
const SENTINEL_CHARS_RE = /[\u0001-\u0005]/g;
const HTML_WS_SPLIT_RE = /[\t\n\f\r ]+/; // same pattern as prettier's htmlWhitespace utility

function maskYatlInternalWhitespace(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(YATL_TAG_RE_G)) {
    out += text.slice(last, m.index);
    out += m[0].replace(WS_CHARS_RE, (ch) => WS_TO_SENTINEL[ch]);
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return out;
}

function unmask(word) {
  return word.replace(SENTINEL_CHARS_RE, (ch) => SENTINEL_TO_WS[ch]);
}

// Split, but keeping the whitespace run that separated each pair of
// words, because whether that run contained a newline is what decides
// between a soft `line` and a forced break below.
function yatlAwareSplitWithSeparators(value) {
  const masked = maskYatlInternalWhitespace(value);
  const words = [];
  const separators = [];
  const re = new RegExp(HTML_WS_SPLIT_RE.source, "g");
  let last = 0;
  let match;
  while ((match = re.exec(masked)) !== null) {
    words.push(unmask(masked.slice(last, match.index)));
    separators.push(match[0]); // whitespace only -- nothing to unmask
    last = match.index + match[0].length;
  }
  words.push(unmask(masked.slice(last)));
  return { words, separators };
}

// ---------------------------------------------------------------------
// Statement tags vs. output tags.
//
// YATL has two kinds of tag: `[[=expr]]` (and `{{=expr}}`) *outputs* a
// value and is genuinely inline -- it belongs in the flow of the text
// around it, exactly like a word. Everything else is a *statement*:
// `[[if ...:]]`, `[[for ...:]]`, `[[else:]]`, `[[pass]]`, `[[end]]`,
// `[[block x]]`, `[[include]]`, `[[extend ...]]`, `[[def ...]]`, plain
// Python lines, etc. Those read as lines of code, and reflowing several
// of them onto one line (`[[pass]] [[else:]] [[for c in x:]]`) destroys
// the only structure the template has.
//
// So: a whitespace run that contained a newline in the source is kept as
// a real line break whenever a statement tag sits on either side of it.
// The rule is deliberately source-driven rather than tag-driven, so an
// intentionally inline construct -- `[[if x:]]a[[else:]]b[[pass]]`
// written on one line -- is left on one line, which is what the author
// asked for by writing it that way.
// ---------------------------------------------------------------------

function isStatementTag(tag) {
  const body = tag.slice(2, -2).trim();
  return body.length > 0 && !body.startsWith("=");
}

function startsWithStatementTag(word) {
  const first = word.match(YATL_TAG_RE);
  return first !== null && first.index === 0 && isStatementTag(first[0]);
}

function endsWithStatementTag(word) {
  const matches = [...word.matchAll(YATL_TAG_RE_G)];
  const last = matches.at(-1);
  return last !== undefined && last.index + last[0].length === word.length && isStatementTag(last[0]);
}

const NEWLINE_RE = /\n/g;

function separatorDoc(separator, before, after) {
  if (!separator.includes("\n")) {
    return line;
  }
  if (!endsWithStatementTag(before) && !startsWithStatementTag(after)) {
    return line;
  }
  // A blank line the author put between two statements is structure too
  // (it separates branches/blocks); keep exactly one.
  return separator.match(NEWLINE_RE).length > 1 ? [hardline, hardline] : hardline;
}

// ---------------------------------------------------------------------
// Vendored from prettier/src/language-html (see file header). Adapted:
// Vue/Angular-only branches dropped (never true for a plain html parse),
// dev-only `assert.ok` invariant checks dropped, CSS *display* table
// dropped entirely (unused by this code path -- only *white-space* is
// needed, see below), locStart/locEnd copied from language-html/loc.js.
// ---------------------------------------------------------------------

const locStart = (node) => node.sourceSpan.start.offset;

// Static subset of the default HTML user-agent stylesheet's `white-space`
// declarations (source: the `html-ua-styles` package prettier itself
// builds this table from), filtered to plain single-tag-name selectors
// exactly like prettier's own `getCssStyleTags("white-space")` does.
// This list is standardized default-rendering behavior (HTML/CSS specs),
// not project-specific config -- it is not expected to change.
const CSS_WHITE_SPACE_TAGS = {
  listing: "pre",
  plaintext: "pre",
  pre: "pre",
  xmp: "pre",
  textarea: "pre-wrap",
  nobr: "nowrap",
  table: "initial",
};
const CSS_WHITE_SPACE_DEFAULT = "normal";

function getNodeCssStyleWhiteSpace(node) {
  if (node.kind === "element" && !node.namespace && Object.hasOwn(CSS_WHITE_SPACE_TAGS, node.name)) {
    return CSS_WHITE_SPACE_TAGS[node.name];
  }
  return CSS_WHITE_SPACE_DEFAULT;
}

function isPreLikeNode(node) {
  return getNodeCssStyleWhiteSpace(node).startsWith("pre");
}

function isTextLikeNode(node) {
  return node.kind === "text" || node.kind === "comment";
}

function getLastDescendant(node) {
  return node.lastChild ? getLastDescendant(node.lastChild) : node;
}

function isPrettierIgnore(node) {
  return node.kind === "comment" && node.value.trim() === "prettier-ignore";
}

function hasPrettierIgnore(node) {
  if (node.kind === "attribute" || !node.parent || !node.prev) {
    return false;
  }
  return isPrettierIgnore(node.prev);
}

// Vue-specific branch of the original dropped: this plugin only ever
// parses plain HTML (options.parser === "yatl-html"), never Vue SFCs.
function shouldPreserveContent(node) {
  if (
    node.kind === "ieConditionalComment" &&
    node.lastChild &&
    !node.lastChild.isSelfClosing &&
    !node.lastChild.endSourceSpan
  ) {
    return true;
  }
  if (node.kind === "ieConditionalComment" && !node.complete) {
    return true;
  }
  if (
    isPreLikeNode(node) &&
    node.children?.some((child) => child.kind !== "text" && child.kind !== "interpolation")
  ) {
    return true;
  }
  return false;
}

function shouldNotPrintClosingTag(node, options) {
  return (
    !node.isSelfClosing &&
    !node.endSourceSpan &&
    (hasPrettierIgnore(node) || shouldPreserveContent(node.parent, options))
  );
}

function needsToBorrowPrevClosingTagEndMarker(node) {
  return (
    node.prev &&
    node.prev.kind !== "docType" &&
    node.kind !== "angularControlFlowBlock" &&
    !isTextLikeNode(node.prev) &&
    node.isLeadingSpaceSensitive &&
    !node.hasLeadingSpaces
  );
}

function needsToBorrowParentClosingTagStartMarker(node) {
  return (
    !node.next &&
    !node.hasTrailingSpaces &&
    node.isTrailingSpaceSensitive &&
    isTextLikeNode(getLastDescendant(node))
  );
}

function needsToBorrowNextOpeningTagStartMarker(node) {
  return (
    node.next &&
    !isTextLikeNode(node.next) &&
    isTextLikeNode(node) &&
    node.isTrailingSpaceSensitive &&
    !node.hasTrailingSpaces
  );
}

function needsToBorrowParentOpeningTagEndMarker(node) {
  return !node.prev && node.isLeadingSpaceSensitive && !node.hasLeadingSpaces;
}

function printClosingTagStartMarker(node, options) {
  if (shouldNotPrintClosingTag(node, options)) {
    return "";
  }
  switch (node.kind) {
    case "ieConditionalComment":
      return "<!";
    case "element":
      if (node.hasHtmComponentClosingTag) {
        return "<//";
      }
    // fall through
    default:
      return `</${node.rawName}`;
  }
}

function printClosingTagEndMarker(node, options) {
  if (shouldNotPrintClosingTag(node, options)) {
    return "";
  }
  switch (node.kind) {
    case "ieConditionalComment":
    case "ieConditionalEndComment":
      return "[endif]-->";
    case "ieConditionalStartComment":
      return "]><!-->";
    case "interpolation":
      return "}}";
    case "angularIcuExpression":
      return "}";
    case "element":
      if (node.isSelfClosing) {
        return "/>";
      }
    // fall through
    default:
      return ">";
  }
}

function printOpeningTagStartMarker(node, options) {
  switch (node.kind) {
    case "ieConditionalComment":
    case "ieConditionalStartComment":
      return `<!--[if ${node.condition}`;
    case "ieConditionalEndComment":
      return "<!--<!";
    case "interpolation":
      return "{{";
    case "docType": {
      const HTML5_DOCTYPE_START_MARKER = "<!doctype";
      if (node.value === "html") {
        const { filepath } = options;
        if (filepath && /\.html?$/.test(filepath)) {
          return HTML5_DOCTYPE_START_MARKER;
        }
      }
      const start = locStart(node);
      return options.originalText.slice(start, start + "<!doctype".length);
    }
    case "angularIcuExpression":
      return "{";
    case "element":
      if (node.condition) {
        return `<!--[if ${node.condition}]><!--><${node.rawName}`;
      }
    // fall through
    default:
      return `<${node.rawName}`;
  }
}

function printOpeningTagEndMarker(node) {
  switch (node.kind) {
    case "ieConditionalComment":
      return "]>";
    case "element":
      if (node.condition) {
        return "><!--<![endif]-->";
      }
    // fall through
    default:
      return ">";
  }
}

function printOpeningTagPrefix(node, options) {
  return needsToBorrowParentOpeningTagEndMarker(node)
    ? printOpeningTagEndMarker(node.parent)
    : needsToBorrowPrevClosingTagEndMarker(node)
      ? printClosingTagEndMarker(node.prev, options)
      : "";
}

function printClosingTagSuffix(node, options) {
  return needsToBorrowParentClosingTagStartMarker(node)
    ? printClosingTagStartMarker(node.parent, options)
    : needsToBorrowNextOpeningTagStartMarker(node)
      ? printOpeningTagStartMarker(node.next, options)
      : "";
}

// ---------------------------------------------------------------------
// The actual behavior change: same shape as prettier's own `case "text":`
// branch in printer-html.js, with `getTextValueParts()` replaced by a
// YATL-aware split -- one that keeps whole `[[...]]`/`{{...}}` spans as
// single words, and that forces (rather than merely allows) a break at a
// source newline next to a statement tag. Only reached for text nodes
// that (a) contain a YATL tag and (b) aren't whitespace-sensitive
// (pre/textarea content is already verbatim/untouched by prettier --
// never split at all, so it's already safe and this is never called for
// it).
// ---------------------------------------------------------------------

function printYatlAwareText(node, options) {
  const prefix = printOpeningTagPrefix(node, options);
  const suffix = printClosingTagSuffix(node, options);
  const { words, separators } = yatlAwareSplitWithSeparators(node.value);

  // fill() wants a flat [content, whitespace, content, whitespace, ...].
  const printed = [];
  for (const [i, word] of words.entries()) {
    if (i > 0) {
      printed.push(separatorDoc(separators[i - 1], words[i - 1], word));
    }
    printed.push(word);
  }

  printed[0] = [prefix, printed[0]];
  printed.push([printed.pop(), suffix]);
  return fill(printed);
}

// ---------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------

const yatlPrinter = {
  ...htmlPlugin.printers.html,
  // Prettier's own AST preprocessing (`print-preprocess.js`) has a pass,
  // `extractInterpolation`, that rewrites `{{ ... }}` text into fake
  // Angular/Vue "interpolation" AST nodes -- a completely different,
  // pre-existing code path from plain "text" nodes, with its own print
  // rules that do NOT go through this plugin's YATL-aware text printer.
  // That pass explicitly skips itself only for the literal parser name
  // "html": `if (options.parser === "html") return;`. Since this plugin
  // must register under its own distinct parser/astFormat name (to
  // avoid Prettier's built-in "html" printer taking priority over ours
  // for the same astFormat), that guard would otherwise never trigger,
  // and YATL's `{{ }}` tags would get silently mangled as if they were
  // Angular interpolations (confirmed: `{{pass}}` was observed getting
  // split across three lines this way). Passing parser:"html" for this
  // one internal, AST-only call restores the guard. Nothing else in the
  // preprocess pipeline branches on options.parser except Vue-specific
  // `=== "vue"` checks, which this does not affect either way.
  preprocess(ast, options) {
    return htmlPlugin.printers.html.preprocess(ast, { ...options, parser: "html" });
  },
  print(path, options, print) {
    const { node } = path;
    if (
      node.kind === "text" &&
      !node.parent.isWhitespaceSensitive &&
      containsYatlTag(node.value)
    ) {
      return printYatlAwareText(node, options);
    }
    return htmlPlugin.printers.html.print(path, options, print);
  },
};

const yatlParser = {
  ...htmlPlugin.parsers.html,
  astFormat: "yatl-html",
};

module.exports = {
  languages: [
    {
      name: "YATL HTML",
      parsers: ["yatl-html"],
      extensions: [".html", ".htm"],
    },
  ],
  parsers: {
    "yatl-html": yatlParser,
  },
  printers: {
    "yatl-html": yatlPrinter,
  },
};
