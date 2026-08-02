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

Traffic goes to a self-hosted [Matomo](https://matomo.org/). The tracker is proxied
through the Worker instead of being loaded from the Matomo host directly, so the browser
only ever talks to `dubsector.dev`:

| Browser request | Proxied to |
| --- | --- |
| `/mtm/mtm.js` | `$MATOMO_ORIGIN/matomo.js` |
| `/mtm/mtm.php` | `$MATOMO_ORIGIN/matomo.php` |

That keeps the tracker off third-party blocklists and keeps the Matomo hostname out of
the page source. The real visitor IP is forwarded as `X-Forwarded-For`, so Matomo needs
this in its `config.ini.php` to geolocate visits correctly rather than attributing them
all to a Cloudflare egress IP:

```ini
[General]
proxy_client_headers[] = HTTP_X_FORWARDED_FOR
```

Two Worker secrets drive it, both set with `npx wrangler secret put <NAME>` (secrets
survive redeploys; plain vars set in the dashboard can be overwritten by `wrangler deploy`):

- `MATOMO_ORIGIN` — base URL of the Matomo install, e.g. `https://analytics.example.com`
- `MATOMO_SITE_ID` — the Matomo site id for dubsector.dev

With either one unset, `/api/analytics` returns 204 and the client skips loading the
tracker entirely.

Tracking only runs on `dubsector.dev`. Secrets belong to the Worker rather than to a
single version, so branch previews (`wrangler versions upload`) inherit them and would
otherwise log preview traffic as real visits; the client checks `location.hostname`
before loading anything, which keeps previews and `wrangler dev` on localhost silent.

Tracking uses Matomo's normal first-party cookies and honours Do Not Track. Beyond the pageview,
each command a visitor types is sent as an event — category `terminal`, action `command`,
name the command line (truncated to 100 chars). Commands run by the scripted intro are
not tracked, only ones typed by hand.
