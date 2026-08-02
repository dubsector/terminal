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

## Analytics

Cookieless [Matomo](https://matomo.org/), self-hosted. Pageviews plus a `terminal` /
`command` event for each command a visitor types by hand. Only runs on `dubsector.dev`,
so branch previews and local dev stay out of the stats.

The tracker is proxied through the Worker (`/mtm/mtm.js` and `/mtm/mtm.php`) so the
browser only ever talks to `dubsector.dev`. Two Worker secrets drive it:

```sh
npx wrangler secret put MATOMO_ORIGIN   # https://analytics.example.com
npx wrangler secret put MATOMO_SITE_ID  # site id for dubsector.dev
```

With either unset, `/api/analytics` returns 204 and the client never loads the tracker.
The visitor IP is forwarded as `X-Visitor-IP`, so Matomo needs
`proxy_client_headers[] = "HTTP_X_VISITOR_IP"` under `[General]` in `config.ini.php`,
otherwise every visit is logged as whatever proxy sits in front of it. It can't ride in
`X-Forwarded-For`: the subrequest crosses Cloudflare's edge on its way to Matomo, and the
edge rewrites that header to the connecting IP of its own leg.
