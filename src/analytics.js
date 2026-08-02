// Matomo tracking, loaded through the Worker's first-party proxy paths (see
// src/worker.js). Everything here is a no-op unless /api/analytics reports a
// configured site, so `npm run build` + a local static server stays silent.

var SCRIPT_URL = "/mtm/mtm.js";
var TRACKER_URL = "/mtm/mtm.php";

var enabled = false;

function paq() {
  window._paq = window._paq || [];
  return window._paq;
}

export function initAnalytics() {
  return fetch("/api/analytics")
    .then(function (res) {
      if (res.status !== 200) return null;
      return res.json();
    })
    .then(function (config) {
      if (!config || !config.siteId) return;

      var q = paq();
      // Cookieless: Matomo falls back to a short-lived config-based visitor
      // id, which keeps the site out of consent-banner territory at the cost
      // of less accurate returning-visitor counts. Drop this line (and honour
      // DNT elsewhere) if that tradeoff ever stops being worth it.
      q.push(["disableCookies"]);
      q.push(["setDoNotTrack", true]);
      q.push(["setTrackerUrl", TRACKER_URL]);
      q.push(["setSiteId", config.siteId]);
      q.push(["trackPageView"]);
      q.push(["enableLinkTracking"]);

      var script = document.createElement("script");
      script.async = true;
      script.src = SCRIPT_URL;
      document.head.appendChild(script);

      enabled = true;
    })
    .catch(function () {
      // Analytics is never worth breaking the page over.
    });
}

// Only the commands a visitor actually types get here - the scripted intro
// calls runCommand() directly, and counting those would drown out the real
// signal of what people explore on their own.
export function trackCommand(line) {
  if (!enabled) return;
  var trimmed = String(line).trim();
  if (!trimmed) return;
  var name = trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
  paq().push(["trackEvent", "terminal", "command", name]);
}
