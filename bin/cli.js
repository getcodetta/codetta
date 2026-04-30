#!/usr/bin/env node
// Codetta is a Tauri desktop app, not a Node-based CLI. This stub exists so
// the npm package has a working `bin` entry — `npx codetta` or
// `npm i -g codetta && codetta` print a friendly pointer to the real
// installer.

const VERSION = require("../package.json").version;

const msg = `
  ⌘  Codetta ${VERSION}
  ─────────────────────────────────────────────────────────────

  Codetta is a desktop application — it doesn't run from npm.

  Download the Windows installer:
    https://github.com/getcodetta/codetta/releases/latest

  Documentation & source:
    https://codetta.dev
    https://github.com/getcodetta/codetta
`;

process.stdout.write(msg + "\n");
