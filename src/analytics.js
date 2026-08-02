// Matomo tracking, loaded through the Worker's first-party proxy paths (see
// src/worker.js). Everything here is a no-op unless /api/analytics reports a
// configured site, so `npm run build` + a local static server stays silent.

var SCRIPT_URL = "/mtm/mtm.js";
var TRACKER_URL = "/mtm/mtm.php";

// Secrets live on the Worker rather than on a single version, so preview
// deploys (`wrangler versions upload` runs on every branch) inherit them and
// would otherwise log branch traffic as real dubsector.dev visits. Only the
// production hostname tracks; previews and localhost stay silent.
var PRODUCTION_HOST = "dubsector.dev";

var enabled = false;

function paq() {
  window._paq = window._paq || [];
  return window._paq;
}

export function initAnalytics() {
  if (window.location.hostname !== PRODUCTION_HOST) return Promise.resolve();

  return fetch("/api/analytics")
    .then(function (res) {
      if (res.status !== 200) return null;
      return res.json();
    })
    .then(function (config) {
      if (!config || !config.siteId) return;

      var q = paq();
      // Cookieless keeps the site out of consent-banner territory: with no
      // cookies, anonymized IPs and a self-hosted install, Matomo qualifies
      // for the CNIL-style consent exemption. The cost is that returning
      // visitors stop being identifiable past the ~24h config-id window,
      // which is close to meaningless on a single-page site with no accounts.
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
