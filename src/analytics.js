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

function trackEvent(action, name) {
  if (!enabled) return;
  var trimmed = String(name).trim();
  if (!trimmed) return;
  paq().push([
    "trackEvent",
    "terminal",
    action,
    trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed,
  ]);
}

// Only the commands a visitor actually types get here - the scripted intro
// calls runCommand() directly, and counting those would drown out the real
// signal of what people explore on their own.
export function trackCommand(line) {
  trackEvent("command", line);
}

// Clicking a directory link runs the same cd/ls a visitor could have typed,
// but it's a separate action so the stats show which way people actually
// explore: whether the links are getting discovered at all, or everyone is
// typing. The clicked name, not the replayed hops, is what's recorded.
export function trackClick(name) {
  trackEvent("click", name);
}

// Matomo's enableLinkTracking only sees real DOM anchors, and these "links"
// are terminal cells painted by xterm's link provider, so outbound clicks
// have to be reported by hand or they don't show up anywhere.
export function trackLink(url) {
  trackEvent("outlink", url);
}
