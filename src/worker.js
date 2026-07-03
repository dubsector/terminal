export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/whoami") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      return new Response(JSON.stringify({ ip }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
