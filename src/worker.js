// Matomo is proxied through this Worker rather than loaded straight off the
// Matomo host: the browser only ever talks to dubsector.dev, so the tracker
// isn't a third-party request (no adblock/tracker-list hit), the self-hosted
// Matomo hostname stays private, and the visitor's real IP still reaches
// Matomo via X-Visitor-IP.
const MATOMO_SCRIPT_PATH = "/mtm/mtm.js";
const MATOMO_TRACK_PATH = "/mtm/mtm.php";

async function proxyToMatomo(request, env, upstreamPath) {
  const origin = env.MATOMO_ORIGIN;
  if (!origin) return new Response("Analytics not configured", { status: 503 });

  const url = new URL(request.url);
  const upstream = new URL(upstreamPath, origin);
  upstream.search = url.search;

  const headers = new Headers();
  for (const name of ["user-agent", "accept", "accept-language", "content-type", "referer"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The visitor IP rides in a custom header rather than X-Forwarded-For.
  // This subrequest goes back out through Cloudflare's edge to reach the
  // tunnel in front of Matomo, and the edge rewrites X-Forwarded-For to
  // the connecting IP of that leg - so anything we put there is gone by
  // the time Matomo reads it, and every visit gets logged as the tunnel.
  // A header Cloudflare doesn't manage survives the trip intact. Matomo
  // reads it via proxy_client_headers[] = HTTP_X_VISITOR_IP.
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Visitor-IP", ip);

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/whoami") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      return new Response(JSON.stringify({ ip }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // The client asks whether analytics is configured before loading
    // anything, so local builds and any deploy without the vars set simply
    // run with tracking off instead of firing requests into a 503.
    if (url.pathname === "/api/analytics") {
      const siteId = env.MATOMO_SITE_ID;
      if (!siteId || !env.MATOMO_ORIGIN) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ siteId: String(siteId) }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === MATOMO_SCRIPT_PATH) {
      return proxyToMatomo(request, env, "/matomo.js");
    }

    if (url.pathname === MATOMO_TRACK_PATH) {
      return proxyToMatomo(request, env, "/matomo.php");
    }

    return env.ASSETS.fetch(request);
  },
};
