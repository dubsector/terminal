# terminal

[![Build check](https://github.com/dubsector/terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/dubsector/terminal/actions/workflows/ci.yml)
[![CodeQL](https://github.com/dubsector/terminal/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/dubsector/terminal/actions/workflows/github-code-scanning/codeql)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-025E8C?logo=dependabot)](https://github.com/dubsector/terminal/network/updates)

Interactive CRT terminal for [dubsector.dev](https://dubsector.dev), built on [xterm.js](https://github.com/xtermjs/xterm.js/).

## Goal

Replace old static CRT mockup with a real, explorable terminal that visitors can actually type into. It boots into a fake login (MOTD shows the visitor's real IP via a Cloudflare Worker endpoint), then drops into a handbuilt shell over a virtual filesystem `ls`, `cd`, `cat`, tab completion, command history, and cursor-aware line editing all implemented on top of xterm.js's raw keystroke events, since xterm.js itself only emulates a terminal and has no shell semantics of its own. The CRT chassis (power button, screen-off animation, phosphor glow) is there to sell the illusion of a real terminal, not just a themed textbox.

## Development

```sh
npm install
npm run dev    # esbuild --watch, writes to dist/
npm run build  # production build to dist/
```

## Deploy

Deploys to Cloudflare Workers (static assets) via Cloudflare's git integration, watching `main`.
Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
