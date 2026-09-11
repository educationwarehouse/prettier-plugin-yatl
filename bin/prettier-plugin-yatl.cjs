#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const prettierBin = require.resolve("prettier/bin/prettier.cjs");
const plugin = path.resolve(__dirname, "../prettier-plugin-yatl.cjs");

const result = spawnSync(
  process.execPath,
  [prettierBin, "--plugin", plugin, "--parser", "yatl-html", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
