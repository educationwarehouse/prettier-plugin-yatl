# prettier-plugin-yatl

Prettier plugin for [YATL](https://github.com/web2py/yatl) templates. It keeps `[[ ... ]]` and `{{ ... }}` expressions together while allowing surrounding HTML text to reflow normally.

## Quick start

Run it directly with Bun. No project configuration or `bun add` is required:

```sh
bunx prettier-plugin-yatl --write template.html
```

The command accepts the usual Prettier options, including globs:

```sh
bunx prettier-plugin-yatl --write 'views/**/*.html'
```

## Configuration

If you prefer to run `prettier` directly, install the plugin and select its parser in `.prettierrc`:

```json
{
  "plugins": ["prettier-plugin-yatl"],
  "overrides": [
    {
      "files": ["*.html", "*.htm"],
      "options": { "parser": "yatl-html" }
    }
  ]
}
```

The explicit parser is needed because Prettier's built-in HTML plugin also handles `.html` and `.htm` files.

Example:

```html
<p>Hello {{= user.name }}. Your status is [[=status]].</p>
```

PyCharm's native HTML formatter does not load Prettier plugins. Use PyCharm's Prettier integration to format YATL templates with this plugin.

## How it works

The plugin reuses Prettier's HTML parser and printer. For ordinary text nodes containing a YATL delimiter, it temporarily replaces whitespace inside `[[...]]` and `{{...}}` spans with non-whitespace sentinel characters. Prettier then cannot wrap inside the span, and the original whitespace is restored afterwards.

All other formatting remains Prettier's responsibility, including tag-boundary whitespace, attributes, comments, and whitespace-sensitive elements such as `<pre>` and `<textarea>`. A small part of Prettier's internal HTML tag-printing logic is vendored because those whitespace markers are not part of its public plugin API.

Delimiter matching follows YATL's non-greedy parser behavior. The plugin does not validate or execute YATL expressions.

## Limitations

- YATL syntax inside `<script>` and `<style>` blocks is not specially handled. Those blocks use Prettier's embedded JavaScript and CSS formatters.
- The plugin is coupled to parts of Prettier's HTML internals. Re-run formatting checks after upgrading Prettier.
