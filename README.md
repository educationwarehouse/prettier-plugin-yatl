# formatl

A Prettier plugin that makes the HTML formatter YATL-aware, so it reflows
text normally but never breaks a line *inside* a `[[ ... ]]` or
`{{ ... }}` template tag (see `example.broken.html`, which is what
PyCharm's/stock Prettier's HTML formatter does to `example.html` today,
vs. `example_good.html`, which is the correct result this plugin now
produces automatically).

## Status

`prettier-plugin-yatl.cjs` is real, tested, working code, verified with
`bun` + a real `prettier@3.9.6` install against:

- `example.html` → byte-identical to `example_good.html`
- a `{{for row in rows:}}...{{pass}}` loop spanning sibling `<li>`s
- `[[ ]]`/`{{ }}` inside attribute values (`class="[[=cls]]"`) — already
  safe even with stock Prettier, since it never reflows inside a single
  attribute value; confirmed unaffected either way
- idempotency (formatting twice gives identical output)
- a YATL tag glued directly against inline elements with no surrounding
  whitespace (`<b>foo</b>[[=x]]<i>bar</i>`)
- the nested-bracket YATL edge case (`[[=data['key'][0]]]`) — matches
  YATL's own actual parser behavior (`yatl/template.py`'s
  `compile("({}.*?{})".format(*escaped_delimiters))` is non-greedy and
  does **not** handle nested brackets either), doesn't crash, and stays
  glued together as one unbreakable run rather than splitting anywhere
- plain HTML with no YATL syntax at all, including a `<pre>` block —
  byte-identical to stock Prettier's own HTML output

There's a superseded first attempt, `formatl.py`, based on
`@formatter:off`/`prettier-ignore` marker comments. That approach
*freezes* formatting of the wrapped element entirely rather than letting
it reflow — it's the wrong mechanism for what this actually needs (see
git history / conversation for why). Superseded by this plugin; kept
only for reference.

## How it works

Prettier's built-in HTML printer decides where a text node can wrap by
splitting it on whitespace with no awareness of `[[ ]]`/`{{ }}` at all —
that's the entire bug. This plugin registers its own parser/printer
(`astFormat: "yatl-html"`) that delegates every node to Prettier's real,
built-in HTML printer *unchanged*, except for text nodes containing a
YATL tag, where it masks whitespace *inside* the tag before Prettier's
own whitespace-splitting logic runs, then restores it — so the tag can
never be split, while everything else reflows exactly as Prettier
normally would.

Getting the surrounding tag-boundary whitespace-borrowing behavior
right (e.g. deciding whether `<b>foo</b> <i>bar</i>` keeps or drops that
middle space) required vendoring a few hundred lines of Prettier's own
internal `print/tag.js` logic, since that logic isn't part of Prettier's
public plugin API. See the comment header in
`prettier-plugin-yatl.cjs` for the full explanation, exactly what was
vendored from where, and the associated maintenance risk (these are
Prettier internals, not a stable public contract — re-run the fixtures
above after bumping the `prettier` version).

## Usage

```
bun install   # or: npm install  (installs prettier as a dev dependency)
```

In your `.prettierrc` (or equivalent):

```json
{
  "plugins": ["./prettier-plugin-yatl.cjs"],
  "overrides": [
    { "files": ["*.html"], "options": { "parser": "yatl-html" } }
  ]
}
```

The explicit `overrides` block is required — Prettier's built-in HTML
plugin also claims the `.html` extension, and internal plugins win that
resolution by default, so the parser must be forced by name.

Then format as usual: `prettier --write "views/**/*.html"`.

### PyCharm integration

PyCharm's native `Ctrl+Alt+L` does **not** use this plugin — it's
IntelliJ's own bundled HTML formatter, with no plugin API this project
can hook into. To get this behavior inside PyCharm, use its built-in
**Prettier** integration instead of native reformat for these files
(Settings → Languages & Frameworks → JavaScript → Prettier — point it at
this project's `prettier` and `.prettierrc`, and either run "Reformat
with Prettier" explicitly or enable "Run on save").

## Known limitations

- Delimiters inside `<script>`/`<style>` raw text aren't specifically
  handled by this plugin — that's a separate Prettier code path
  (embedded-language formatting) from the HTML text-node case this
  plugin patches. Verified behavior: a `[[ ]]`/`{{ }}` tag placed where
  it makes the surrounding JS/CSS syntactically invalid (the common
  case, e.g. `var x = [[=value]];`) makes Prettier's embedded parser
  fail, and Prettier falls back to leaving that entire `<script>`/
  `<style>` block's content untouched, verbatim — safe (no corruption),
  just no JS/CSS formatting benefit for that block. A tag placed fully
  *inside* a string literal (`var x = "[[=value]]"`) is safe too, same
  as any other string content. Not verified: a tag positioned so it
  coincidentally still parses as valid JS/CSS syntax — untested and
  probably rare in practice, but not guaranteed safe.
- Vendored Prettier internals (see above) — a future `prettier` version
  bump isn't guaranteed compatible; it fails silently (wrong formatting,
  not a crash) rather than loudly, so re-run the fixtures above after
  bumping.
