# terminal

[![Build check](https://github.com/dubsector/terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/dubsector/terminal/actions/workflows/ci.yml)
[![CodeQL](https://github.com/dubsector/terminal/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/dubsector/terminal/actions/workflows/github-code-scanning/codeql)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-025E8C?logo=dependabot)](https://github.com/dubsector/terminal/network/updates)

Interactive CRT terminal for [dubsector.dev](https://dubsector.dev), built on [xterm.js](https://github.com/xtermjs/xterm.js/).

## Development

```sh
npm install
npm run dev    # esbuild --watch, writes to dist/
npm run build  # production build to dist/
```

## Deploy

Deploys to Cloudflare Workers (static assets) via Cloudflare's git integration, watching `main`.
Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
