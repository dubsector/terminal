# terminal

Interactive CRT terminal for [dubsector.dev](https://dubsector.dev), built on [xterm.js](https://xtermjs.org/).

## Development

```sh
npm install
npm run dev    # esbuild --watch, writes to dist/
npm run build  # production build to dist/
```

## Deploy

Deploys to Cloudflare Workers (static assets) via Cloudflare's git integration, watching `main`.
Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
