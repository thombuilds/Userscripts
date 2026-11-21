// ==UserScript==
// @name         YouTube Tweaks (Podcasts page, player, compact Home)
// @description  Separate "Podcasts" page in the sidebar; trimmed player (no subtitles/AirPlay, highest quality, minimal settings menu); compact Home grid.
// @version      1.7.0
// @match        https://www.youtube.com/*
// @run-at       document-start
// @inject-into  auto
// @noframes
// @grant        none
// ==/UserScript==

/*
 * HOW THIS FILE IS ORGANIZED
 *   1. CONFIG              – the knobs you'll want to tweak (channels, min duration, keywords…)
 *   2. STORAGE             – localStorage helpers (your overrides, prefs)
 *   3. SMALL UTILITIES     – element builder, time/duration parsing, tree walking
 *   4. YOUTUBE DATA        – pulling videos out of ytInitialData / continuation JSON / tiles
 *   5. CLASSIFIER          – "is this a podcast?" + your per-tile overrides
 *   6. CLEANUP             – deletes the Home cache older versions saved (nothing is saved now)
 *   7. FETCHING            – background fetch of /feed/subscriptions and /, plus "load more"
 *   8. CSS                 – styles (uses YouTube's own CSS variables → dark/light for free)
 *   9. SIDEBAR ENTRY       – "Podcasts" in the left guide + the collapsed mini-guide
 *  10. PODCASTS PAGE       – the overlay page, sections, tiles, buttons, toast
 *  11. NAVIGATION          – #podcasts hash, back/forward, YouTube SPA events
 *  12. PLAYER              – hide subtitles/AirPlay, force highest quality, trim the settings menu
 *  13. SHORTS              – hide Shorts everywhere, open /shorts/ links in the normal player
 *  14. GRID LAYOUT         – 5 tiles per row on every YouTube video grid, same as the Podcasts page
 *  15. BOOT                – start-up + one throttled MutationObserver
 *
 * Every id / class we add starts with "ytpod-" so it never clashes with YouTube.
 *
 * WHY NO innerHTML: YouTube enforces Trusted Types, so assigning HTML strings
 * throws when this runs in the page world. Everything is built with
 * createElement (see h() below).
 *
 * WHY localStorage (not GM storage): with "@inject-into auto" the script may run
 * in the page world, where the Userscripts app gives no GM_* APIs. localStorage
 * works in both worlds and is shared with youtube.com only.
 *
 * Anything marked "UNSURE" depends on YouTube internals (JSON paths, element
 * names) that I couldn't verify and that YouTube changes now and then. If
 * something breaks, start there. With CONFIG.debug = true, `ytpod` is
 * exposed in the console (page world only), e.g.
 * ytpod.collectVideos(ytInitialData).
 */

(() => {
  "use strict";

  if (window.top !== window) return; // never inside iframes (embeds, chat…)
  if (window.__ytpodLoaded) return; // guard against double injection
  window.__ytpodLoaded = true;

  /* ======================================================================
   * 1. CONFIG
   * ==================================================================== */
  const CONFIG = {
    // Channel names (as shown on YouTube) or handles ("@lexfridman"). Case-insensitive.
    podcastChannels: [
      // "Lex Fridman",
      // "@hubermanlab",
    ],
    notPodcastChannels: [
      // "Some Long-Video Gaming Channel",
    ],

    // A video at least this long counts as a podcast.
    minDurationMinutes: 40,

    // A title matching any of these counts as a podcast.
    titleKeywords: [
      /\bpodcast/i, // podcast, podcasts
      /\bepisode\b/i,
      /\bep\./i, // "Ep. 12"
      /#\d+/, // "#123"
    ],

    // Count YouTube's own "Podcast" badge (when it shows one).
    useYouTubeBadge: true,

    // What the "Always podcast" / "Not a podcast" buttons save:
    //   "channel" → applies to every video from that channel
    //   "video"   → applies to that one video only
    // Option(Alt)-click a button to use the other scope for that one click.
    overrideScope: "channel",


    // "Load more" (and the first load) keeps fetching continuation pages until it
    // finds this many new podcasts, or has fetched pagesPerLoad pages.
    minNewPerLoad: 8,
    pagesPerLoad: 3,

    // Re-fetch the feeds on opening the page if the last fetch is older than this.
    refetchAfterMinutes: 10,

    // URL hash of the Podcasts page (youtube.com/#podcasts).
    hash: "podcasts",

    // Podcasts page: load more automatically when you scroll near the bottom.
    infiniteScroll: true,
    autoLoadMarginPx: 1200, // start loading this far before the actual bottom

    // ---- Player ----
    hideSubtitles: true, // CC button + the captions themselves
    hideAirPlay: true,
    forceHighestQuality: true,
    // Settings (gear) menu: only items whose label starts with one of these stay.
    // Labels are as shown in YouTube's UI language (English here).
    playerSettingsKeep: ["Quality", "Sleep timer"],

    // ---- Shorts ----
    // Hide Shorts everywhere (sidebar, shelves, tiles, tabs, chips) and turn
    // /shorts/ links and pages into the normal player.
    hideShorts: true,
    shortsLabel: "Shorts", // as written in YouTube's UI language

    // ---- Grids (Home, Subscriptions, channel pages, and our Podcasts page) ----
    // Every video grid shows tilesPerRow tiles per row. In a narrow window it
    // drops columns rather than make tiles narrower than tileMinWidth px.
    // Set uniformGrids: false to leave YouTube's own grids alone.
    uniformGrids: true,
    tilesPerRow: 5,
    tileMinWidth: 200,
    tileGapX: 16,
    tileGapY: 36,

    debug: false,
  };

  const VERSION = "1.7.0"; // keep in sync with @version; shown on the Podcasts page and in the console
  const HASH = "#" + CONFIG.hash;
  const log = (...a) => CONFIG.debug && console.log("[YT Podcasts]", ...a);

  /* ======================================================================
   * 2. STORAGE
   * ==================================================================== */
  const PREFIX = "ytpod:";
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) {
        console.warn("[YT Podcasts] could not save", key, e);
      }
    },
  };

  // Your button choices. videos: { videoId: "pod" | "not" }, channels: { key: "pod" | "not" }
  let overrides = store.get("overrides", { videos: {}, channels: {} });
  overrides.videos ||= {};
  overrides.channels ||= {};
  const saveOverrides = () => store.set("overrides", overrides);

  const prefs = store.get("prefs", { showHidden: false });
  const savePrefs = () => store.set("prefs", prefs);

  /* ======================================================================
   * 3. SMALL UTILITIES
   * ==================================================================== */

  /** Tiny element builder: h("a", {class, href, onclick, text, style:{}}, ...children) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false || kid === "") continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // Material "podcasts" icon, drawn as an SVG (no innerHTML).
  const PODCAST_ICON_PATH =
    "M14 12c0 .74-.4 1.38-1 1.72V22h-2v-8.28c-.6-.35-1-.98-1-1.72 0-1.1.9-2 2-2s2 .9 2 2zm-2-6c-3.31 0-6 2.69-6 6 0 1.74.75 3.31 1.94 4.4l1.42-1.42C8.53 14.25 8 13.19 8 12c0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.19-.53 2.25-1.36 2.98l1.42 1.42C17.25 15.31 18 13.74 18 12c0-3.31-2.69-6-6-6zm0-4C6.48 2 2 6.48 2 12c0 2.85 1.2 5.41 3.11 7.24l1.42-1.42C4.98 16.36 4 14.29 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8c0 2.29-.98 4.36-2.53 5.82l1.42 1.42C20.8 17.41 22 14.85 22 12c0-5.52-4.48-10-10-10z";
  function podcastIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", PODCAST_ICON_PATH);
    svg.appendChild(path);
    return svg;
  }

  // "1:02:33" / "45:10"
  const DUR_RE = /^\d{1,3}(?::\d{2}){1,2}$/;
  const parseDuration = (t) =>
    t && DUR_RE.test(t.trim()) ? t.trim().split(":").reduce((a, b) => a * 60 + Number(b), 0) : null;

  // "3 days ago", "Streamed 2 weeks ago", and YouTube's newer short forms
  // "3d ago", "22h ago", "1mo ago", "5m ago" (m = minutes, mo = months).
  // English UI only; other languages just show YouTube's text and sort after the dated ones.
  const AGO_RE =
    /(\d+)\s*(seconds?|secs?|minutes?|mins?|months?|mos?|hours?|hrs?|days?|weeks?|wks?|years?|yrs?|s|m|h|d|w|y)\s+ago\b/i;
  const UNIT_SEC = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  function unitOf(u) {
    u = u.toLowerCase();
    if (u.startsWith("mo")) return "month";
    if (u.startsWith("m")) return "minute";
    return { s: "second", h: "hour", d: "day", w: "week", y: "year" }[u[0]];
  }
  function ageToTimestamp(text, base) {
    const m = AGO_RE.exec(text || "");
    return m ? base - Number(m[1]) * UNIT_SEC[unitOf(m[2])] * 1000 : null;
  }
  /** "Nov 18" (adds the year if it isn't this year). */
  function shortDate(ts) {
    const d = new Date(ts);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }
  function formatAgo(ms) {
    const s = Math.max(0, ms / 1000);
    for (const u of ["year", "month", "week", "day", "hour", "minute"]) {
      const n = Math.floor(s / UNIT_SEC[u]);
      if (n >= 1) return `${n} ${u}${n > 1 ? "s" : ""} ago`;
    }
    return "just now";
  }

  /** Depth-first walk over a JSON tree. visit(obj) returns true to skip that obj's children. */
  function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, visit);
      return;
    }
    if (visit(node)) return;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, visit);
    }
  }

  /** YouTube text objects: {simpleText} | {runs:[{text}]} | {content} | "string" */
  function textOf(t) {
    if (!t) return "";
    if (typeof t === "string") return t;
    if (typeof t.simpleText === "string") return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || "").join("");
    if (typeof t.content === "string") return t.content;
    return "";
  }

  const normName = (s) => (s || "").trim().toLowerCase();

  function waitFor(fn, timeout = 10000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const r = fn();
        if (r || Date.now() - t0 > timeout) return resolve(r);
        setTimeout(poll, 200);
      })();
    });
  }

  // Page world = we can see YouTube's own JS objects (ytcfg, Polymer .data).
  const inPageWorld = () => {
    try {
      return typeof window.ytcfg?.get === "function";
    } catch {
      return false;
    }
  };

  /* ======================================================================
   * 4. YOUTUBE DATA
   *    Every source ends up as the same plain "video" object:
   *    { id, title, channel, channelUrl, durationText, durationSec,
   *      publishedText, progress (0-100), badges: [strings] }
   * ==================================================================== */

  function makeVideo(o) {
    if (!o.id) return null;
    const durationText = (o.durationText || "").trim();
    return {
      id: o.id,
      title: (o.title || "").trim(),
      channel: (o.channel || "").trim(),
      channelUrl: o.channelUrl || "",
      durationText,
      durationSec: parseDuration(durationText),
      publishedText: (o.publishedText || "").trim(),
      progress: Number(o.progress) || 0,
      badges: (o.badges || []).map((b) => String(b).trim()).filter(Boolean),
    };
  }

  /** Classic videoRenderer / gridVideoRenderer. UNSURE: paths as of 2024-2026. */
  function fromVideoRenderer(r) {
    if (!r?.videoId) return null;
    if (r.upcomingEventData) return null; // scheduled premieres / streams: not watchable yet
    const overlays = r.thumbnailOverlays || [];
    const timeOv = overlays.find((o) => o.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer;
    const resume = overlays.find((o) => o.thumbnailOverlayResumePlaybackRenderer)?.thumbnailOverlayResumePlaybackRenderer;
    const owner = r.ownerText || r.shortBylineText || r.longBylineText;
    const ownerNav = owner?.runs?.[0]?.navigationEndpoint;
    const badges = [...(r.badges || []), ...(r.ownerBadges || [])]
      .map((b) => b.metadataBadgeRenderer?.label || b.metadataBadgeRenderer?.tooltip || "")
      .filter(Boolean);
    if (timeOv?.style === "LIVE") badges.push("LIVE");
    return makeVideo({
      id: r.videoId,
      title: textOf(r.title) || r.title?.accessibility?.accessibilityData?.label,
      channel: textOf(owner),
      channelUrl: ownerNav?.browseEndpoint?.canonicalBaseUrl || ownerNav?.commandMetadata?.webCommandMetadata?.url,
      durationText: textOf(r.lengthText) || textOf(timeOv?.text),
      publishedText: textOf(r.publishedTimeText),
      progress: resume?.percentDurationWatched,
      badges,
    });
  }

  /** Newer lockupViewModel (Home and Subscriptions are moving to it). UNSURE: all paths. */
  function fromLockup(l) {
    if (!l?.contentId) return null;
    if (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null; // playlists, mixes…
    const md = l.metadata?.lockupMetadataViewModel || {};
    const rows = md.metadata?.contentMetadataViewModel?.metadataRows || [];
    const firstRow = rows[0]?.metadataParts || [];
    const parts = rows.flatMap((r) => (r.metadataParts || []).map((p) => textOf(p.text)).filter(Boolean));

    let channelUrl = "";
    walk([md.image, firstRow], (o) => {
      const u = o.browseEndpoint?.canonicalBaseUrl;
      if (u && !channelUrl) channelUrl = u;
      return false;
    });

    // Thumbnail overlays: duration badge + watched progress bar. UNSURE: names.
    const badgeTexts = [];
    let progress = 0;
    walk(l.contentImage, (o) => {
      if (o.thumbnailBadgeViewModel) badgeTexts.push(textOf(o.thumbnailBadgeViewModel.text));
      if (typeof o.startPercent === "number") progress = Math.max(progress, o.startPercent);
      if (typeof o.percentDurationWatched === "number") progress = Math.max(progress, o.percentDurationWatched);
      return false;
    });
    // Badges in the metadata area (e.g. "New"; maybe "Podcast"). UNSURE.
    walk(md, (o) => {
      if (o.badgeViewModel) badgeTexts.push(textOf(o.badgeViewModel.badgeText));
      return false;
    });

    return makeVideo({
      id: l.contentId,
      title: textOf(md.title),
      channel: textOf(firstRow[0]?.text),
      channelUrl,
      durationText: badgeTexts.find((t) => DUR_RE.test(t.trim())) || "",
      publishedText: parts.find((t) => AGO_RE.test(t)) || "",
      progress,
      badges: [...badgeTexts, ...parts.filter((t) => t.length <= 20)],
    });
  }

  /**
   * Find every video plus the "next page" token anywhere in a ytInitialData or
   * browse-continuation response. Shorts (reelItemRenderer /
   * shortsLockupViewModel) are not video renderers, so they're skipped.
   */
  function collectVideos(root) {
    const videos = [];
    const seen = new Set();
    let token = null;
    walk(root, (o) => {
      // UNSURE: ad wrapper names. Skip them so promoted videos never show up.
      if (o.adSlotRenderer || o.promotedVideoRenderer || o.inFeedAdLayoutRenderer) return true;
      if (o.continuationItemRenderer) {
        walk(o.continuationItemRenderer, (c) => {
          if (c.continuationCommand?.token) token = c.continuationCommand.token;
          return false;
        });
        return true;
      }
      let v;
      if (o.videoRenderer) v = fromVideoRenderer(o.videoRenderer);
      else if (o.gridVideoRenderer) v = fromVideoRenderer(o.gridVideoRenderer);
      else if (o.lockupViewModel) v = fromLockup(o.lockupViewModel);
      else return false;
      if (v && !seen.has(v.id)) {
        seen.add(v.id);
        videos.push(v);
      }
      return true;
    });
    return { videos, token };
  }

  /** Slice a balanced {...} JSON object out of a big string, starting at a "{". */
  function sliceBalanced(s, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  /** Decode a single-quoted JS string literal body ('\x7b\x22…'). */
  function decodeJsString(raw) {
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0" };
    return raw.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, e) => {
      if (e.length === 3 && e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
      if (e.length === 5 && e[0] === "u") return String.fromCharCode(parseInt(e.slice(1), 16));
      return simple[e] ?? e;
    });
  }

  /** ytInitialData from a fetched HTML page. UNSURE: marker spellings. */
  function parseInitialData(html) {
    for (const marker of ["var ytInitialData = ", 'window["ytInitialData"] = ', "ytInitialData = "]) {
      const i = html.indexOf(marker);
      if (i < 0) continue;
      let j = i + marker.length;
      while (html[j] === " ") j++;
      try {
        if (html[j] === "{") {
          const s = sliceBalanced(html, j);
          if (s) return JSON.parse(s);
        } else if (html[j] === "'") {
          // Some variants ship it as an escaped string literal.
          let k = j + 1;
          while (k < html.length && !(html[k] === "'" && html[k - 1] !== "\\")) k++;
          return JSON.parse(decodeJsString(html.slice(j + 1, k)));
        }
      } catch (e) {
        log("ytInitialData parse failed for marker", marker, e);
      }
    }
    return null;
  }

  /** All ytcfg.set({...}) blocks of a fetched page, merged. Needed for continuation requests. */
  function parseYtcfg(html) {
    const out = {};
    let i = 0;
    while ((i = html.indexOf("ytcfg.set({", i)) >= 0) {
      const s = sliceBalanced(html, i + 10);
      if (s) {
        try {
          Object.assign(out, JSON.parse(s));
        } catch {
          /* not every block is strict JSON; fine */
        }
      }
      i += 10;
    }
    return out;
  }

  /* ======================================================================
   * 5. CLASSIFIER
   *    Order: your button override (video, then channel) → notPodcastChannels →
   *    podcastChannels → YouTube "Podcast" badge → duration → title keywords.
   * ==================================================================== */

  function channelKeys(v) {
    const keys = [normName(v.channel)];
    const handle = /\/(@[^/?#]+)/.exec(v.channelUrl || "");
    if (handle) keys.push(normName(decodeURIComponent(handle[1])));
    return keys.filter(Boolean);
  }

  const inList = (list, v) => {
    const keys = channelKeys(v);
    return list.some((x) => keys.includes(normName(x)));
  };

  function overrideFor(v) {
    if (overrides.videos[v.id]) return { val: overrides.videos[v.id], scope: "video" };
    for (const k of channelKeys(v)) if (overrides.channels[k]) return { val: overrides.channels[k], scope: "channel" };
    return null;
  }

  /** → { isPodcast, reason } */
  function classify(v) {
    const ov = overrideFor(v);
    if (ov) return { isPodcast: ov.val === "pod", reason: `Marked by you (${ov.scope === "video" ? "this video" : "channel"})` };
    if (inList(CONFIG.notPodcastChannels, v)) return { isPodcast: false, reason: "In notPodcastChannels" };
    if (inList(CONFIG.podcastChannels, v)) return { isPodcast: true, reason: "In podcastChannels" };
    // UNSURE: whether/where YouTube exposes a "Podcast" label on feed tiles.
    if (CONFIG.useYouTubeBadge && v.badges?.some((b) => /^podcast$/i.test(b))) return { isPodcast: true, reason: "YouTube Podcast badge" };
    if (v.durationSec != null && v.durationSec >= CONFIG.minDurationMinutes * 60)
      return { isPodcast: true, reason: `≥ ${CONFIG.minDurationMinutes} min` };
    const kw = CONFIG.titleKeywords.find((re) => re.test(v.title || ""));
    if (kw) return { isPodcast: true, reason: `Title: “${(v.title.match(kw) || [""])[0]}”` };
    return { isPodcast: false, reason: "No podcast signal" };
  }

  /**
   * Button handler. Clicking the button that's already on clears the override.
   * Clicking with Alt flips CONFIG.overrideScope for that one click.
   */
  function setOverride(v, val, flipScope) {
    const snapshot = JSON.stringify(overrides);
    const scope = (CONFIG.overrideScope === "video") !== !!flipScope ? "video" : "channel";
    const current = overrideFor(v);
    // Clear anything that applies to this tile, then set the new value (unless toggling off).
    delete overrides.videos[v.id];
    for (const k of channelKeys(v)) delete overrides.channels[k];
    let msg;
    if (current?.val === val) {
      msg = "Override cleared";
    } else if (scope === "video") {
      overrides.videos[v.id] = val;
      msg = `This video → ${val === "pod" ? "always podcast" : "not a podcast"}`;
    } else {
      for (const k of channelKeys(v)) overrides.channels[k] = val;
      msg = `${v.channel || "Channel"} → ${val === "pod" ? "always podcast" : "not a podcast"}`;
    }
    saveOverrides();
    render();
    toast(msg, () => {
      overrides = JSON.parse(snapshot);
      saveOverrides();
      render();
    });
  }

  /* ======================================================================
   * 6. CLEANUP
   *    Versions before 1.6 remembered podcast tiles seen on Home. Recommended
   *    now comes only from a fresh load of your Home feed, so delete that list.
   * ==================================================================== */
  try {
    localStorage.removeItem(PREFIX + "cache");
  } catch {
    /* ignore */
  }

  /* ======================================================================
   * 7. FETCHING
   * ==================================================================== */

  let parsedCfg = {}; // ytcfg read from fetched HTML (fallback for the content world)
  function cfg(key) {
    try {
      const v = window.ytcfg?.get?.(key);
      if (v != null) return v;
    } catch {
      /* content world */
    }
    return parsedCfg[key];
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Signed-in innertube requests need SAPISIDHASH auth. UNSURE: exact current format. */
  async function authHeader() {
    const cookies = {};
    for (const c of document.cookie.split(/;\s*/)) {
      const i = c.indexOf("=");
      if (i > 0) cookies[c.slice(0, i)] = c.slice(i + 1);
    }
    const ts = Math.floor(Date.now() / 1000);
    const make = async (name, val) => (val ? `${name} ${ts}_${await sha1Hex(`${ts} ${val} ${location.origin}`)}` : null);
    const parts = await Promise.all([
      make("SAPISIDHASH", cookies.SAPISID || cookies["__Secure-3PAPISID"]),
      make("SAPISID1PHASH", cookies["__Secure-1PAPISID"]),
      make("SAPISID3PHASH", cookies["__Secure-3PAPISID"]),
    ]);
    return parts.filter(Boolean).join(" ") || null;
  }

  /** GET an HTML page (same origin, your cookies) → its ytInitialData. */
  async function fetchInitialData(path) {
    const res = await fetch(path, { credentials: "include", headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    const html = await res.text();
    Object.assign(parsedCfg, parseYtcfg(html));
    const data = parseInitialData(html);
    if (!data) throw new Error("Couldn't find ytInitialData (consent page, or YouTube changed?)");
    return data;
  }

  /** POST /youtubei/v1/browse with a continuation token → next page JSON. UNSURE: headers. */
  async function fetchContinuation(token) {
    const context = cfg("INNERTUBE_CONTEXT");
    if (!context) throw new Error("Missing INNERTUBE_CONTEXT, can't load more");
    const headers = {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": String(cfg("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
      "X-Youtube-Client-Version": cfg("INNERTUBE_CLIENT_VERSION") || context.client?.clientVersion || "",
      "X-Origin": location.origin,
      "X-Goog-AuthUser": String(cfg("SESSION_INDEX") ?? 0),
    };
    const visitor = context.client?.visitorData || cfg("VISITOR_DATA");
    if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
    const pageId = cfg("DELEGATED_SESSION_ID"); // brand accounts
    if (pageId) headers["X-Goog-PageId"] = pageId;
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const key = cfg("INNERTUBE_API_KEY");
    const url = `/youtubei/v1/browse?prettyPrint=false${key ? "&key=" + encodeURIComponent(key) : ""}`;
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, continuation: token }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading more`);
    return res.json();
  }

  const newFeed = (path) => ({ path, items: new Map(), token: null, loading: false, error: null, fetchedAt: 0, baseTime: 0, dryAutoLoads: 0 });

  const state = {
    open: false,
    savedScroll: 0,
    order: 0, // running counter = feed order, used as a sort tiebreaker
    feeds: { subs: newFeed("/feed/subscriptions"), home: newFeed("/") },
  };

  /**
   * Load a feed. more=false: fresh first page (replaces what we had).
   * Either way, keep fetching continuation pages until minNewPerLoad new
   * podcasts turn up or pagesPerLoad pages have been fetched.
   * auto=true: triggered by scrolling (see maybeAutoLoad).
   */
  async function loadFeed(kind, { more = false, auto = false } = {}) {
    const f = state.feeds[kind];
    if (f.loading) return;
    f.loading = true;
    f.error = null;
    render();
    let newPods = 0;
    const ingest = (videos) => {
      for (const v of videos) {
        if (f.items.has(v.id)) continue;
        v.order = ++state.order;
        v.publishedAt = ageToTimestamp(v.publishedText, f.baseTime);
        v.fresh = true;
        f.items.set(v.id, v);
        if (classify(v).isPodcast) newPods++;
      }
    };
    try {
      let pages = 0;
      if (!more) {
        const data = await fetchInitialData(f.path);
        f.items = new Map();
        f.baseTime = f.fetchedAt = Date.now();
        const { videos, token } = collectVideos(data);
        f.token = token;
        ingest(videos);
        pages = 1;
        if (!videos.length && !token)
          throw new Error(kind === "subs" ? "No videos found. Are you signed in?" : "No videos found on Home.");
        render();
      }
      while (f.token && pages < CONFIG.pagesPerLoad && newPods < CONFIG.minNewPerLoad) {
        const { videos, token } = collectVideos(await fetchContinuation(f.token));
        f.token = token;
        ingest(videos);
        pages++;
        render();
        if (!videos.length) break;
      }
    } catch (e) {
      console.warn("[YT Podcasts]", kind, e);
      f.error = e.message || String(e);
    } finally {
      f.loading = false;
      // Several automatic loads in a row with no podcasts: stop auto-loading
      // (the button still works, and clicking it re-enables auto-loading).
      f.dryAutoLoads = auto && newPods === 0 ? f.dryAutoLoads + 1 : 0;
      render();
      setTimeout(maybeAutoLoad, 300); // still at the bottom (or page not full yet)? keep going
    }
  }

  /** Infinite scroll: load more for the visible tab when you're near the bottom of our page. */
  function maybeAutoLoad() {
    if (!CONFIG.infiniteScroll || !state.open || !pageEl) return;
    const f = state.feeds[prefs.tab === "subs" ? "subs" : "home"];
    if (f.loading || !f.token || !f.fetchedAt || f.error || f.dryAutoLoads >= 3) return;
    if (pageEl.scrollTop + pageEl.clientHeight < pageEl.scrollHeight - CONFIG.autoLoadMarginPx) return;
    loadFeed(prefs.tab === "subs" ? "subs" : "home", { more: true, auto: true });
  }

  function ensureFeedsLoaded(force = false) {
    const staleMs = CONFIG.refetchAfterMinutes * 60000;
    for (const kind of ["subs", "home"]) {
      const f = state.feeds[kind];
      if (force || !f.fetchedAt || Date.now() - f.fetchedAt > staleMs) loadFeed(kind);
    }
  }

  /* ======================================================================
   * 8. CSS
   *    YouTube's --yt-spec-* variables switch with dark/light mode, so we use
   *    them, with fallbacks for light (default) and dark (html[dark]).
   * ==================================================================== */
  const CSS = `
    #ytpod-page, .ytpod-guide-entry, .ytpod-mini-entry, #ytpod-toast {
      --ytpod-text:  var(--yt-spec-text-primary, #0f0f0f);
      --ytpod-text2: var(--yt-spec-text-secondary, #606060);
      --ytpod-hover: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1));
      --ytpod-chip:  var(--yt-spec-badge-chip-background, rgba(0,0,0,.05));
      --ytpod-bg:    var(--yt-spec-base-background, #fff);
      --ytpod-red:   var(--yt-spec-static-brand-red, #f00);
      --ytpod-blue:  var(--yt-spec-call-to-action, #065fd4);
    }
    html[dark] #ytpod-page, html[dark] .ytpod-guide-entry, html[dark] .ytpod-mini-entry, html[dark] #ytpod-toast {
      --ytpod-text:  var(--yt-spec-text-primary, #f1f1f1);
      --ytpod-text2: var(--yt-spec-text-secondary, #aaa);
      --ytpod-hover: var(--yt-spec-10-percent-layer, rgba(255,255,255,.1));
      --ytpod-chip:  var(--yt-spec-badge-chip-background, rgba(255,255,255,.1));
      --ytpod-bg:    var(--yt-spec-base-background, #0f0f0f);
      --ytpod-blue:  var(--yt-spec-call-to-action, #3ea6ff);
    }

    /* ---- sidebar entry (full guide), sized like ytd-guide-entry-renderer ---- */
    .ytpod-guide-entry {
      display: flex; align-items: center; gap: 24px;
      height: 40px; padding: 0 12px; border-radius: 10px; box-sizing: border-box;
      color: var(--ytpod-text); text-decoration: none;
      font: 400 14px/20px Roboto, Arial, sans-serif; cursor: pointer;
    }
    .ytpod-guide-entry:hover { background: var(--ytpod-hover); }
    .ytpod-guide-entry.ytpod-active { background: var(--ytpod-hover); font-weight: 500; }
    .ytpod-guide-entry svg { width: 24px; height: 24px; fill: currentColor; flex: none; }

    /* ---- collapsed mini-guide entry ---- */
    .ytpod-mini-entry {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      width: 64px; padding: 16px 0 14px; border-radius: 10px; box-sizing: border-box;
      color: var(--ytpod-text); text-decoration: none;
      font: 400 10px/14px Roboto, Arial, sans-serif; cursor: pointer;
    }
    .ytpod-mini-entry:hover, .ytpod-mini-entry.ytpod-active { background: var(--ytpod-hover); }
    .ytpod-mini-entry svg { width: 24px; height: 24px; fill: currentColor; }

    /* While our page is open, un-highlight YouTube's active entry (e.g. Home). UNSURE: selectors. */
    html.ytpod-open ytd-guide-entry-renderer[active],
    html.ytpod-open ytd-guide-entry-renderer[active] #endpoint,
    html.ytpod-open ytd-guide-entry-renderer[active] tp-yt-paper-item,
    html.ytpod-open ytd-mini-guide-entry-renderer[aria-selected="true"],
    html.ytpod-open ytd-mini-guide-entry-renderer[aria-selected="true"] a { background-color: transparent !important; }
    html.ytpod-open ytd-guide-entry-renderer[active] .title,
    html.ytpod-open ytd-guide-entry-renderer[active] yt-formatted-string { font-weight: 400 !important; }

    /* ---- the page: a fixed panel over YouTube's content area.
       top/left are set by positionPage() (below the masthead, right of the sidebar). ---- */
    #ytpod-page { display: none; }
    html.ytpod-open #ytpod-page { display: block; }
    /* Hide YouTube's own page underneath (stops its infinite scroll, no double scrollbars). */
    html.ytpod-open #page-manager > * { display: none !important; }
    /* On Home, the masthead's blurred backdrop grows to cover the chip bar and
       would sit on top of our header. UNSURE: id. */
    html.ytpod-open #frosted-glass { height: var(--ytd-masthead-height, 56px) !important; }
    #ytpod-page {
      position: fixed; top: 56px; left: 0; right: 0; bottom: 0; z-index: 1000;
      overflow-y: auto; overscroll-behavior: contain;
      background: var(--ytpod-bg); color: var(--ytpod-text); font-family: Roboto, Arial, sans-serif;
      padding: 16px 24px 80px; box-sizing: border-box;
    }
    .ytpod-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
    .ytpod-tabs { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 16px; }
    .ytpod-tab {
      border: none; border-radius: 8px; height: 32px; padding: 0 12px; cursor: pointer;
      background: var(--ytpod-chip); color: var(--ytpod-text); font: 500 14px/32px Roboto, Arial, sans-serif;
    }
    .ytpod-tab:hover { background: var(--ytpod-hover); }
    .ytpod-tab.ytpod-on { background: var(--ytpod-text); color: var(--ytpod-bg); }
    .ytpod-tab-count { margin-left: 6px; font-weight: 400; opacity: .7; }
    .ytpod-status-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    .ytpod-head h1 { display: flex; align-items: center; gap: 12px; margin: 0; font: 700 28px/36px Roboto, Arial, sans-serif; }
    .ytpod-version { font: 400 12px/1 Roboto, Arial, sans-serif; color: var(--ytpod-text2); align-self: flex-end; margin-bottom: 6px; }
    .ytpod-head h1 svg { width: 32px; height: 32px; fill: currentColor; }
    .ytpod-head-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .ytpod-toggle { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--ytpod-text2); cursor: pointer; }

    .ytpod-status { font-size: 13px; color: var(--ytpod-text2); min-height: 18px; }
    .ytpod-status.ytpod-error { color: var(--ytpod-red); }

    .ytpod-grid {
      display: grid; gap: ${CONFIG.tileGapY}px ${CONFIG.tileGapX}px;
      /* Exactly tilesPerRow columns, fewer only if tiles would get narrower than tileMinWidth. */
      grid-template-columns: repeat(auto-fill, minmax(max(${CONFIG.tileMinWidth}px, calc((100% - ${(CONFIG.tilesPerRow - 1) * CONFIG.tileGapX}px) / ${CONFIG.tilesPerRow})), 1fr));
    }

    /* ---- tiles ---- */
    .ytpod-tile { min-width: 0; transition: opacity .15s; }
    .ytpod-tile.ytpod-dim { opacity: .45; }
    .ytpod-tile.ytpod-dim:hover { opacity: 1; }
    .ytpod-thumb {
      position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden;
      border-radius: 12px; background: var(--ytpod-chip);
    }
    .ytpod-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ytpod-dur {
      position: absolute; right: 8px; bottom: 8px; padding: 1px 4px; border-radius: 4px;
      background: rgba(0,0,0,.8); color: #fff; font: 500 12px/18px Roboto, Arial, sans-serif;
    }
    .ytpod-thumb.ytpod-has-prog .ytpod-dur { bottom: 12px; }
    .ytpod-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(255,255,255,.45); }
    .ytpod-prog > div { height: 100%; background: var(--ytpod-red); }

    .ytpod-meta { margin-top: 12px; padding-right: 8px; }
    .ytpod-title {
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      color: var(--ytpod-text); text-decoration: none; font: 500 16px/22px Roboto, Arial, sans-serif;
    }
    .ytpod-sub { margin-top: 4px; font: 400 14px/20px Roboto, Arial, sans-serif; color: var(--ytpod-text2); }
    .ytpod-sub a { color: inherit; text-decoration: none; }
    .ytpod-sub a:hover { color: var(--ytpod-text); }
    .ytpod-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .ytpod-reason { font-size: 12px; color: var(--ytpod-text2); }

    /* ---- buttons (YouTube-style pills) ---- */
    .ytpod-btn {
      border: none; border-radius: 16px; padding: 5px 10px; cursor: pointer;
      background: var(--ytpod-chip); color: var(--ytpod-text);
      font: 500 12px/16px Roboto, Arial, sans-serif;
    }
    .ytpod-btn:hover { background: var(--ytpod-hover); }
    .ytpod-btn.ytpod-on { background: var(--ytpod-text); color: var(--ytpod-bg); }
    .ytpod-btn.ytpod-big { font-size: 14px; padding: 8px 16px; border-radius: 18px; }
    .ytpod-btn[disabled] { opacity: .5; cursor: default; }
    .ytpod-link { border: none; background: none; padding: 0; cursor: pointer; font-size: 13px; color: var(--ytpod-blue); }
    .ytpod-foot { display: flex; justify-content: center; margin-top: 24px; }
    .ytpod-more {
      border: 1px solid var(--ytpod-hover); background: transparent; color: var(--ytpod-blue);
      border-radius: 18px; padding: 8px 20px; cursor: pointer; font: 500 14px/20px Roboto, Arial, sans-serif;
    }
    .ytpod-more:hover { background: var(--ytpod-chip); }
    .ytpod-more[disabled] { opacity: .6; cursor: default; }
    .ytpod-empty { grid-column: 1 / -1; font-size: 14px; color: var(--ytpod-text2); }

    /* ---- toast with Undo ---- */
    #ytpod-toast {
      position: fixed; left: 24px; bottom: 24px; z-index: 9999;
      display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-radius: 8px;
      background: var(--ytpod-text); color: var(--ytpod-bg);
      font: 400 14px/20px Roboto, Arial, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.3);
    }
    #ytpod-toast button { border: none; background: none; cursor: pointer; font: 500 14px Roboto, Arial; color: #3ea6ff; }
    html[dark] #ytpod-toast button { color: #065fd4; }
  `;

  function injectStyles() {
    if (document.getElementById("ytpod-style")) return;
    const style = document.createElement("style");
    style.id = "ytpod-style";
    style.textContent = CSS + playerCss() + shortsCss() + gridCss(); // textContent on <style> is fine under Trusted Types
    (document.head || document.documentElement).appendChild(style);
  }

  /* ======================================================================
   * 9. SIDEBAR ENTRY
   *    Our own <a> placed after YouTube's Subscriptions entry. (A cloned Polymer
   *    element would render empty.) YouTube can re-render the guide, so the
   *    observer calls ensureGuideEntries() again whenever ours is gone.
   * ==================================================================== */

  /**
   * Is this entry part of a normal vertical list? In the current guide,
   * "Subscriptions >" is a section *heading* built from the same
   * ytd-guide-entry-renderer (id="header-entry"), sitting in a horizontal row.
   * Inserting next to it puts us sideways in the heading. So besides skipping
   * known heading ids, we refuse any parent that lays its children out in a row.
   * UNSURE: the heading ids.
   */
  function isListEntry(el) {
    if (!el || el.id === "header-entry" || el.closest("#header-entry, #header")) return false;
    if (el.tagName === "YTD-MINI-GUIDE-ENTRY-RENDERER") return true;
    const parent = el.parentElement;
    if (!parent) return false;
    const cs = getComputedStyle(parent);
    const isRow = /flex/.test(cs.display) && !/column/.test(cs.flexDirection);
    return !isRow;
  }

  /**
   * Where "Podcasts" goes: after the Subscriptions entry if that's a list item
   * (older guide); otherwise (current guide, where Subscriptions is only a
   * heading) at the end of Home's group, i.e. after Shorts.
   * Re-checked on every tick: the guide stamps its entries lazily, so Shorts
   * may show up after we've inserted ours, and then we move.
   */
  function desiredAnchor(tag) {
    const entries = [...document.querySelectorAll(tag)].filter(isListEntry);
    const subs = entries.find((el) => el.querySelector('a[href^="/feed/subscriptions"]'));
    if (subs) return subs;
    const home = entries.find((el) => el.querySelector('a[href="/"]'));
    if (!home) return null;
    const group = [...home.parentElement.children].filter((el) => el.tagName === home.tagName);
    return group[group.length - 1];
  }

  /** Copy the horizontal box (offset, width, height, radius) of YouTube's own entry. */
  function syncEntryBox(el, anchor) {
    const ref = anchor.querySelector("tp-yt-paper-item") || anchor.querySelector("a") || anchor;
    const r = ref.getBoundingClientRect();
    if (!r.width) return; // guide hidden right now
    const cur = el.getBoundingClientRect();
    const margin = (parseFloat(el.style.marginLeft) || 0) + (r.left - cur.left);
    if (Math.abs(r.left - cur.left) > 0.5) el.style.marginLeft = margin + "px";
    if (Math.abs(r.width - cur.width) > 0.5) el.style.width = r.width + "px";
    if (r.height && Math.abs(r.height - cur.height) > 0.5) el.style.height = r.height + "px";
    const radius = getComputedStyle(ref).borderRadius;
    if (radius && radius !== "0px") el.style.borderRadius = radius;
  }

  function placeEntry(id, tag) {
    const anchor = desiredAnchor(tag);
    if (!anchor) return;
    let el = document.getElementById(id);
    if (!el) el = h("a", { id, class: id, href: HASH, title: "Podcasts" }, podcastIcon(), h("span", {}, "Podcasts"));
    if (el.previousElementSibling !== anchor) anchor.after(el);
    syncEntryBox(el, anchor);
  }

  function ensureGuideEntries() {
    placeEntry("ytpod-guide-entry", "ytd-guide-entry-renderer");
    placeEntry("ytpod-mini-entry", "ytd-mini-guide-entry-renderer");
    for (const id of ["ytpod-guide-entry", "ytpod-mini-entry"])
      document.getElementById(id)?.classList.toggle("ytpod-active", state.open);
  }

  /** If the guide is a pop-over drawer (narrow window / watch page), close it. UNSURE. */
  function closeDrawerIfOverlay() {
    const app = document.querySelector("ytd-app");
    const drawer = document.querySelector("tp-yt-app-drawer#guide");
    if (!drawer?.hasAttribute("opened") || app?.hasAttribute("guide-persistent-and-visible")) return;
    const btn = drawer.querySelector("#guide-button button, #guide-button") ||
      document.querySelector("ytd-masthead #guide-button button, ytd-masthead #guide-button");
    btn?.click();
  }

  /* ======================================================================
   * 10. PODCASTS PAGE
   * ==================================================================== */

  let pageEl = null;
  const sections = {}; // kind → { el, status, grid, more }
  const tabs = {}; // kind → { btn, count }
  const TAB_TITLES = { subs: "From your subscriptions", rec: "Recommended" };
  if (!TAB_TITLES[prefs.tab]) prefs.tab = "subs";

  function buildPage() {
    const toggle = h("input", {
      type: "checkbox",
      onchange: (e) => {
        prefs.showHidden = e.target.checked;
        savePrefs();
        render();
      },
    });
    toggle.checked = !!prefs.showHidden;

    pageEl = h("div", { id: "ytpod-page" },
      h("div", { class: "ytpod-head" },
        h("h1", {}, podcastIcon(), "Podcasts", h("span", { class: "ytpod-version", title: "Script version" }, "v" + VERSION)),
        h("div", { class: "ytpod-head-actions" },
          h("label", { class: "ytpod-toggle", title: "Also show videos the classifier skipped, so you can mark them" },
            toggle, "Show non-podcasts"),
          h("button", { class: "ytpod-btn ytpod-big", onclick: () => ensureFeedsLoaded(true) }, "Refresh"))),
      h("div", { class: "ytpod-tabs" }, buildTab("subs"), buildTab("rec")),
      buildSection("subs"),
      buildSection("rec"));
    let scrollTimer = 0;
    pageEl.addEventListener("scroll", () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = 0;
        maybeAutoLoad();
      }, 150);
    }, { passive: true });
  }

  /** YouTube-style chip that switches between the two sections. */
  function buildTab(kind) {
    const t = { count: h("span", { class: "ytpod-tab-count" }) };
    t.btn = h("button", {
      class: "ytpod-tab",
      onclick: () => {
        prefs.tab = kind;
        savePrefs();
        pageEl.scrollTop = 0;
        render();
        maybeAutoLoad();
      },
    }, TAB_TITLES[kind], t.count);
    tabs[kind] = t;
    return t.btn;
  }

  function buildSection(kind) {
    const s = {
      status: h("div", { class: "ytpod-status" }),
      grid: h("div", { class: "ytpod-grid" }),
      more: h("button", { class: "ytpod-more", onclick: () => loadFeed(kind === "subs" ? "subs" : "home", { more: true }) }, "Load more"),
    };
    s.el = h("section", { class: "ytpod-section" },
      h("div", { class: "ytpod-status-row" }, s.status),
      s.grid,
      h("div", { class: "ytpod-foot" }, s.more));
    sections[kind] = s;
    return s.el;
  }

  /**
   * The page is a fixed panel appended to <body>. Living inside YouTube's
   * #page-manager let YouTube's layout CSS shift it and its blurred masthead
   * backdrop cover it, so we position it ourselves instead.
   */
  function mountPage() {
    if (!pageEl) buildPage();
    if (pageEl.parentNode !== document.body) document.body.appendChild(pageEl);
    positionPage();
  }

  /** top = bottom of the masthead; left = right edge of the docked sidebar (full or mini). UNSURE: selectors. */
  function positionPage() {
    if (!pageEl || !state.open) return;
    const mast = document.querySelector("ytd-masthead") || document.querySelector("#masthead-container");
    const top = Math.round(mast?.getBoundingClientRect().bottom || 0) || 56;
    let left = 0;
    // Only a *docked* guide pushes content right; the pop-over drawer floats above us.
    for (const el of document.querySelectorAll("tp-yt-app-drawer#guide[persistent][opened] #contentContainer, ytd-mini-guide-renderer")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.left < 5) left = Math.max(left, r.right);
    }
    if (!left) {
      // Fallback: YouTube offsets #page-manager by the sidebar width.
      const pm = document.querySelector("#page-manager");
      left = pm ? Math.max(0, pm.getBoundingClientRect().left) : 0;
    }
    const t = top + "px";
    const l = Math.round(left) + "px";
    if (pageEl.style.top !== t) pageEl.style.top = t;
    if (pageEl.style.left !== l) pageEl.style.left = l;
  }
  window.addEventListener("resize", positionPage);

  // Newest first. Items without a parseable date go last, in feed order.
  function byNewest(a, b) {
    const pa = a.publishedAt ?? -Infinity;
    const pb = b.publishedAt ?? -Infinity;
    if (pa !== pb) return pb - pa;
    const oa = a.order ?? Infinity;
    const ob = b.order ?? Infinity;
    return oa - ob;
  }

  const withClass = (list) => list.map((v) => ({ v, cls: classify(v) }));

  function subsList() {
    return withClass([...state.feeds.subs.items.values()].sort(byNewest));
  }

  /**
   * Your Home feed exactly as YouTube serves it right now, in YouTube's own
   * order. Videos that are also in the Subscriptions tab stay too, as on Home.
   * Nothing is saved.
   */
  function recList() {
    return withClass([...state.feeds.home.items.values()]);
  }

  function render() {
    if (!pageEl || !state.open) return;
    renderSection("subs", subsList(), state.feeds.subs);
    renderSection("rec", recList(), state.feeds.home);
    ensureGuideEntries();
  }

  function renderSection(kind, list, feed) {
    const s = sections[kind];
    const podcasts = list.filter((x) => x.cls.isPodcast);
    const shown = prefs.showHidden ? list : podcasts;

    tabs[kind].count.textContent = feed.loading && !podcasts.length ? "…" : String(podcasts.length);
    tabs[kind].btn.classList.toggle("ytpod-on", prefs.tab === kind);
    s.el.hidden = prefs.tab !== kind;

    let status;
    if (feed.error) status = `Couldn't load: ${feed.error}`;
    else if (feed.loading) status = "Loading…";
    else if (kind === "subs") status = feed.fetchedAt ? `Checked the latest ${feed.items.size} videos from your subscriptions` : "";
    else status = feed.fetchedAt ? `From your Home feed, in YouTube's order (${feed.items.size} videos checked)` : "";
    s.status.textContent = status;
    s.status.classList.toggle("ytpod-error", !!feed.error);

    const tiles = shown.map(renderTile);
    if (!tiles.length && !feed.loading)
      tiles.push(h("div", { class: "ytpod-empty" }, feed.token ? "No podcasts here yet. Try “Load more”." : "No podcasts found."));
    s.grid.replaceChildren(...tiles);

    s.more.hidden = !feed.token;
    s.more.disabled = feed.loading;
    s.more.textContent = feed.loading ? "Loading…" : "Load more";
  }

  function renderTile({ v, cls }) {
    const url = `/watch?v=${encodeURIComponent(v.id)}`;
    const ov = overrideFor(v);
    const progress = Math.min(100, v.progress || 0);
    const scopeText = CONFIG.overrideScope === "video" ? "this video" : "this channel";
    const otherText = CONFIG.overrideScope === "video" ? "the whole channel" : "this video only";
    // Upload time: "3 days ago · Nov 18" (approximate: YouTube only gives "3d ago").
    const streamed = /^streamed/i.test(v.publishedText || "") ? "Streamed " : "";
    const when = v.publishedAt != null
      ? `${streamed}${formatAgo(Date.now() - v.publishedAt)} · ${shortDate(v.publishedAt)}`
      : v.publishedText;

    // Watched videos are never hidden; they just get the red progress bar.
    return h("div", { class: "ytpod-tile" + (cls.isPodcast ? "" : " ytpod-dim") },
      h("a", { class: "ytpod-thumb" + (progress > 0 ? " ytpod-has-prog" : ""), href: url, onclick: (e) => onWatchClick(e, v) },
        h("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: "", loading: "lazy" }),
        v.durationText && h("span", { class: "ytpod-dur" }, v.durationText),
        progress > 0 && h("div", { class: "ytpod-prog" }, h("div", { style: { width: progress + "%" } }))),
      h("div", { class: "ytpod-meta" },
        h("a", { class: "ytpod-title", href: url, title: v.title, onclick: (e) => onWatchClick(e, v) }, v.title || "(untitled)"),
        h("div", { class: "ytpod-sub", title: v.publishedAt != null ? `Uploaded around ${new Date(v.publishedAt).toLocaleString()}` : null },
          v.channelUrl ? h("a", { href: v.channelUrl }, v.channel) : v.channel,
          v.channel && when ? " • " : "", when),
        h("div", { class: "ytpod-actions" },
          h("button", {
            class: "ytpod-btn" + (ov?.val === "pod" ? " ytpod-on" : ""),
            title: `Always treat ${scopeText} as a podcast. Option-click: ${otherText}. Click again to undo.`,
            onclick: (e) => setOverride(v, "pod", e.altKey),
          }, "Always podcast"),
          h("button", {
            class: "ytpod-btn" + (ov?.val === "not" ? " ytpod-on" : ""),
            title: `Never treat ${scopeText} as a podcast. Option-click: ${otherText}. Click again to undo.`,
            onclick: (e) => setOverride(v, "not", e.altKey),
          }, "Not a podcast"),
          h("span", { class: "ytpod-reason", title: "Why the classifier decided this" }, cls.reason))));
  }

  let toastTimer = 0;
  function toast(message, undo) {
    document.getElementById("ytpod-toast")?.remove();
    clearTimeout(toastTimer);
    const el = h("div", { id: "ytpod-toast" },
      h("span", {}, message),
      undo && h("button", { onclick: () => { el.remove(); undo(); } }, "Undo"));
    document.body.appendChild(el);
    toastTimer = setTimeout(() => el.remove(), 5000);
  }

  /* ======================================================================
   * 11. NAVIGATION
   *    Opening pushes "<current url>#podcasts", so Back closes the page and
   *    Forward reopens it. YouTube's SPA events close it when you navigate away.
   * ==================================================================== */

  // After Back lands on "#podcasts", YouTube may re-render that page and drop
  // the hash. For a few seconds we re-open (and restore the hash) when that happens.
  let reopenUntil = 0;
  const urlWithoutHash = () => location.pathname + location.search;

  function openPodcasts({ push = true } = {}) {
    // history.state is copied so YouTube's own popstate handling still recognizes the entry. UNSURE.
    if (push && location.hash !== HASH) history.pushState(history.state, "", urlWithoutHash() + HASH);
    if (!state.open) {
      state.savedScroll = window.scrollY;
      if (location.pathname.startsWith("/watch")) document.querySelector("video")?.pause();
      state.open = true;
      document.documentElement.classList.add("ytpod-open");
      // Follow the sidebar collapsing/expanding (attribute changes the observer doesn't see).
      clearInterval(state.posTimer);
      state.posTimer = setInterval(positionPage, 500);
    }
    mountPage();
    if (push) pageEl.scrollTop = 0; // fresh open from the sidebar; Back keeps your place
    ensureFeedsLoaded();
    render();
  }

  function closePodcasts({ restoreScroll = true } = {}) {
    if (!state.open) return;
    state.open = false;
    clearInterval(state.posTimer);
    document.documentElement.classList.remove("ytpod-open");
    ensureGuideEntries();
    if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, state.savedScroll));
  }

  function stripHash() {
    if (location.hash === HASH) history.replaceState(history.state, "", urlWithoutHash());
  }

  /** Clicking a tile: close our page (hash stays, so Back returns here) and go to the video. */
  function onWatchClick(e, v) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab etc.: browser default
    e.preventDefault();
    const url = `/watch?v=${encodeURIComponent(v.id)}`;
    reopenUntil = 0;
    closePodcasts({ restoreScroll: false });
    if (spaNavigate(url, v.id)) {
      // If YouTube ignored our event, do a normal page load instead.
      setTimeout(() => {
        if (!location.href.includes(v.id)) location.href = url;
      }, 1500);
    } else {
      location.href = url;
    }
  }

  /**
   * Ask YouTube's SPA router to open a video (no full reload). Only works in the
   * page world. UNSURE: event shape; this is what yt-simple-endpoint fires.
   */
  function spaNavigate(url, videoId) {
    const app = document.querySelector("ytd-app");
    if (!app || !inPageWorld()) return false;
    try {
      app.dispatchEvent(new CustomEvent("yt-navigate", {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } },
            watchEndpoint: { videoId },
          },
        },
      }));
      return true;
    } catch {
      return false;
    }
  }

  function onHistoryChange() {
    if (location.hash === HASH) {
      reopenUntil = Date.now() + 4000;
      openPodcasts({ push: false });
    } else if (state.open) {
      closePodcasts();
    }
  }
  window.addEventListener("popstate", onHistoryChange);
  window.addEventListener("hashchange", onHistoryChange);

  // YouTube SPA navigation. UNSURE: event names are stable for years but undocumented.
  document.addEventListener("yt-navigate-start", () => {
    if (state.open && Date.now() > reopenUntil) closePodcasts({ restoreScroll: false });
  });
  document.addEventListener("yt-navigate-finish", () => {
    redirectShorts();
    ensureGuideEntries();
    if (location.pathname.startsWith("/watch")) applyHighestQuality();
    if (location.hash === HASH || Date.now() < reopenUntil) {
      if (location.hash !== HASH) history.replaceState(history.state, "", urlWithoutHash() + HASH);
      reopenUntil = 0;
      openPodcasts({ push: false });
    } else if (state.open) {
      closePodcasts({ restoreScroll: false });
    }
  });

  // Clicks: our sidebar entries open the page; other sidebar/logo links close it.
  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const ours = target.closest(".ytpod-guide-entry, .ytpod-mini-entry");
    if (ours) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      reopenUntil = 0;
      closeDrawerIfOverlay();
      openPodcasts();
      return;
    }
    if (!state.open) return;
    const link = target.closest("a[href]");
    if (link && link.closest("ytd-guide-renderer, ytd-mini-guide-renderer, ytd-topbar-logo-renderer")) {
      reopenUntil = 0;
      closePodcasts({ restoreScroll: false });
      stripHash();
    }
  }, true);

  /* ======================================================================
   * 12. PLAYER
   * ==================================================================== */

  function playerCss() {
    let css = `
      /* Settings menu items we filtered out (see filterSettingsMenus). */
      .ytpod-hide { display: none !important; }
    `;
    if (CONFIG.hideSubtitles)
      css += `
      .ytp-subtitles-button,
      .ytp-caption-window-container { display: none !important; }`;
    if (CONFIG.hideAirPlay) // UNSURE: class name; the aria-label match is the backup
      css += `
      .ytp-airplay-button,
      .ytp-chrome-controls button[aria-label*="AirPlay" i] { display: none !important; }`;
    return css;
  }

  /*
   * Highest quality.
   * Page world: the player's own API (getAvailableQualityLevels lists the
   * best first). Once per video, so picking a quality by hand still sticks.
   * Both worlds: also store YouTube's quality preference in localStorage,
   * which the player reads at start-up. UNSURE: that key's format.
   */
  let qualityDoneFor = "";
  function applyHighestQuality(attempt = 0) {
    if (!CONFIG.forceHighestQuality) return;
    const p = document.getElementById("movie_player");
    if (!p || typeof p.getAvailableQualityLevels !== "function") return; // content world / no player
    let vid = "";
    try {
      vid = p.getVideoData?.()?.video_id || "";
    } catch {
      /* ignore */
    }
    if (!vid || vid === qualityDoneFor) return;
    const levels = (p.getAvailableQualityLevels() || []).filter((q) => q !== "auto");
    if (!levels.length) {
      if (attempt < 20) setTimeout(() => applyHighestQuality(attempt + 1), 500); // not known yet
      return;
    }
    const best = levels[0];
    try {
      p.setPlaybackQualityRange?.(best, best);
      p.setPlaybackQuality?.(best);
      qualityDoneFor = vid;
      log("quality →", best, "for", vid);
    } catch (e) {
      log("could not set quality", e);
    }
  }

  function storeQualityPreference() {
    if (!CONFIG.forceHighestQuality) return;
    try {
      const now = Date.now();
      localStorage.setItem("yt-player-quality", JSON.stringify({
        data: JSON.stringify({ quality: 4320, previousQuality: 1080 }), // 4320 = 8K, i.e. "as high as it goes"
        expiration: now + 365 * 86400000,
        creation: now,
      }));
    } catch {
      /* ignore */
    }
  }

  // Media events don't bubble, but a capturing listener on document still sees them.
  // "loadeddata" fires for every new video, including autoplay-next and SPA navigation.
  document.addEventListener("loadeddata", (e) => {
    if (e.target instanceof HTMLVideoElement && e.target.closest("#movie_player")) applyHighestQuality();
  }, true);

  /*
   * Settings (gear) menu: keep only CONFIG.playerSettingsKeep.
   *
   * This deliberately doesn't depend on the menu's class names: the newer
   * player changed them and the class-based version silently did nothing.
   * Instead:
   *   1. Find every menu item on the page (ARIA roles, plus .ytp-menuitem).
   *   2. The ones labelled like a keep entry ("Quality", "Sleep timer") are anchors.
   *   3. From an anchor, walk up to the first ancestor holding 3+ menu items:
   *      that's the main settings list.
   *   4. Hide every item in that list whose label doesn't start with a keep entry.
   * Submenus are safe: no item in the quality list, the sleep-timer options or
   * the speed list is labelled "Quality" or "Sleep timer", so none becomes an
   * anchor. Other menus on the page (the ⋮ menus) have no such items either.
   */
  const MENU_ITEM_SEL = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], .ytp-menuitem';

  function menuLabel(item) {
    const label = item.querySelector(".ytp-menuitem-label") || item;
    return (label.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function hideEl(el, hide) {
    if (hide) {
      el.classList.add("ytpod-hide");
      // Inline !important as well, in case a stylesheet out-ranks our class.
      if (el.style.getPropertyPriority("display") !== "important") el.style.setProperty("display", "none", "important");
    } else if (el.classList.contains("ytpod-hide")) {
      el.classList.remove("ytpod-hide");
      el.style.removeProperty("display");
    }
  }

  function filterSettingsMenus() {
    const keep = (CONFIG.playerSettingsKeep || []).map((k) => k.toLowerCase());
    if (!keep.length) return;
    const isKept = (item) => keep.some((k) => menuLabel(item).startsWith(k));
    const lists = new Set();
    for (const item of document.querySelectorAll(MENU_ITEM_SEL)) {
      if (!isKept(item) || item.parentElement?.closest(MENU_ITEM_SEL)) continue;
      let list = item.parentElement;
      while (list && list !== document.body && list.querySelectorAll(MENU_ITEM_SEL).length < 3) list = list.parentElement;
      if (list && list !== document.body) lists.add(list);
    }
    for (const list of lists) {
      // Only items at the top level of the list (not parts nested inside an item).
      const items = [...list.querySelectorAll(MENU_ITEM_SEL)].filter((item) => {
        const outer = item.parentElement?.closest(MENU_ITEM_SEL);
        return !(outer && list.contains(outer));
      });
      // Must really be the main menu: it has toggle switches (Stable Volume,
      // Ambient mode…) or both kept entries. A submenu whose "‹ Quality" back
      // button happens to be a menu item has neither, so the quality list is safe.
      const hasToggle = items.some((item) => item.getAttribute("role") === "menuitemcheckbox");
      if (!hasToggle && items.filter(isKept).length < Math.min(2, keep.length)) continue;
      for (const item of items) hideEl(item, !isKept(item));
      fitMenuHeight(list, items);
    }
  }

  /**
   * Make the trimmed menu compact.
   *
   * YouTube sizes the menu (and its panel / item list) in pixels for all 8
   * items, and the newer player stretches the remaining items to fill that
   * space: 2 items → two half-height rows with a big gap. So:
   *   1. Measure one item's natural height with an invisible, absolutely
   *      positioned copy (absolute = can't be stretched). Cached per list.
   *   2. Pin the kept items to that height (no stretching).
   *   3. Shrink every box YouTube sized in pixels to
   *      rows × row height + paddings.
   * Never height:auto: the panels are absolutely positioned, so the menu would
   * collapse to 0px (that was the v1.3 bug). Only shrinks, and re-running
   * changes nothing, so it can't fight YouTube in a loop. Skipped while closed.
   */
  function naturalRowHeight(list, sample) {
    if (list.dataset.ytpodRowH) return Number(list.dataset.ytpodRowH);
    const copy = sample.cloneNode(true);
    copy.removeAttribute("id");
    copy.classList.remove("ytpod-hide");
    copy.style.cssText +=
      `;position:absolute !important;visibility:hidden !important;left:0 !important;top:0 !important;` +
      `flex:none !important;height:auto;width:${sample.getBoundingClientRect().width}px !important;`;
    copy.style.removeProperty("height"); // let YouTube's stylesheet height (if any) apply
    sample.parentElement.appendChild(copy);
    let h = copy.getBoundingClientRect().height;
    copy.remove();
    if (!(h >= 24 && h <= 96)) h = 48; // implausible → a typical row height
    list.dataset.ytpodRowH = String(h);
    return h;
  }

  function fitMenuHeight(list, items) {
    const visible = items.filter((i) => !i.classList.contains("ytpod-hide"));
    const listRect = list.getBoundingClientRect();
    if (!visible.length || !listRect.height) return; // menu closed
    const px = (v) => parseFloat(v) || 0;
    const rowH = naturalRowHeight(list, visible[0]);

    // 2. Kept items: natural height, no stretching. rowH is a border-box
    //    height; for content-box items subtract padding/border, or they grow.
    for (const item of visible) {
      const ics = getComputedStyle(item);
      const extra = ics.boxSizing === "border-box" ? 0 :
        px(ics.paddingTop) + px(ics.paddingBottom) + px(ics.borderTopWidth) + px(ics.borderBottomWidth);
      const h = Math.max(0, rowH - extra) + "px";
      if (item.style.getPropertyValue("height") !== h) {
        item.style.setProperty("flex", "0 0 auto", "important");
        item.style.setProperty("height", h, "important");
      }
    }

    // 3. Target border-box height of the list itself.
    const lcs = getComputedStyle(list);
    const listWant = rowH * visible.length + px(lcs.rowGap) * (visible.length - 1) +
      px(lcs.paddingTop) + px(lcs.paddingBottom) + px(lcs.borderTopWidth) + px(lcs.borderBottomWidth);

    const changes = [];
    let below = 0; // padding/border of wrappers below the list, accumulated outwards
    let el = list;
    for (let n = 0; el && n < 4; n++, el = el.parentElement) {
      if (el.matches(".html5-video-player, #movie_player, body")) break;
      // Stop at a box that also shows other menu items (a submenu sliding in):
      // shrinking it would clip the submenu.
      if (el !== list && [...el.querySelectorAll(MENU_ITEM_SEL)].some((i) => !list.contains(i) && i.getClientRects().length)) break;
      const cs = getComputedStyle(el);
      if (el !== list) below += px(cs.paddingBottom) + px(cs.borderBottomWidth);
      if (!/px$/.test(el.style.height)) continue; // only boxes YouTube sized explicitly
      let want = listRect.top - el.getBoundingClientRect().top + listWant + below; // border-box
      if (cs.boxSizing !== "border-box") want -= px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      if (want > 0 && px(el.style.height) - want > 1) changes.push([el, Math.ceil(want) + "px"]);
    }
    for (const [box, h] of changes) box.style.height = h; // measure everything first, then apply
  }

  // Run often enough to catch the menu before you see it, cheaply:
  //  - on the regular tick (YouTube builds the menu when the player loads),
  //  - every frame for 1.5 s after any click inside the player (opening the gear,
  //    going into a submenu and back),
  //  - on any change inside the player, at most once per frame.
  let menuRaf = 0;
  const scheduleMenuFilter = () => {
    if (!menuRaf) menuRaf = requestAnimationFrame(() => { menuRaf = 0; filterSettingsMenus(); });
  };
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".html5-video-player, #movie_player")) return;
    const until = Date.now() + 1500;
    (function loop() {
      filterSettingsMenus();
      if (Date.now() < until) requestAnimationFrame(loop);
    })();
  }, true);

  function watchPlayers() {
    for (const player of document.querySelectorAll(".html5-video-player")) {
      if (player.dataset.ytpodWatched) continue;
      player.dataset.ytpodWatched = "1";
      new MutationObserver(scheduleMenuFilter).observe(player, { childList: true, subtree: true });
    }
  }

  /* ======================================================================
   * 13. SHORTS
   *    CSS hides anything that is or links to a Short (needs :has, Safari 15.4+).
   *    JS hides things only recognizable by their text ("Shorts" chips/tabs),
   *    and sends /shorts/<id> links and pages to /watch?v=<id>.
   *    UNSURE: element names and attributes.
   * ==================================================================== */

  function shortsCss() {
    if (!CONFIG.hideShorts) return "";
    return `
      /* Sidebar + collapsed sidebar entry */
      ytd-guide-entry-renderer:has(a[href^="/shorts"]),
      ytd-guide-entry-renderer:has(a[title="${CONFIG.shortsLabel}"]),
      ytd-mini-guide-entry-renderer:has(a[href^="/shorts"]),
      ytd-mini-guide-entry-renderer[aria-label="${CONFIG.shortsLabel}"],
      /* Shorts shelves (Home, Subscriptions, search, channel pages) */
      ytd-rich-shelf-renderer[is-shorts],
      ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
      ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2),
      grid-shelf-view-model:has(ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2),
      ytd-reel-shelf-renderer,
      /* Single Shorts anywhere: grids, search, watch-page sidebar, notifications */
      ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2,
      ytd-rich-item-renderer:has(a[href^="/shorts/"]),
      ytd-video-renderer:has(a[href^="/shorts/"]),
      ytd-grid-video-renderer:has(a[href^="/shorts/"]),
      ytd-compact-video-renderer:has(a[href^="/shorts/"]),
      yt-lockup-view-model:has(a[href^="/shorts/"]),
      ytd-notification-renderer:has(a[href^="/shorts/"]),
      /* Channel page tab */
      yt-tab-shape[tab-title="${CONFIG.shortsLabel}"] { display: none !important; }
    `;
  }

  /** Things only recognizable by their label: filter chips, tabs, sidebar entries. */
  function hideShortsByText() {
    if (!CONFIG.hideShorts) return;
    const label = CONFIG.shortsLabel.toLowerCase();
    const sel = "yt-chip-cloud-chip-renderer, chip-shape, yt-tab-shape, tp-yt-paper-tab, ytd-search-filter-renderer, " +
      "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer";
    for (const el of document.querySelectorAll(sel)) {
      if (el.classList.contains("ytpod-hide")) continue;
      if ((el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === label) el.classList.add("ytpod-hide");
    }
  }

  const shortsId = (path) => (/^\/shorts\/([\w-]{6,})/.exec(path) || [])[1];

  /** On a /shorts/ page → the same video in the normal player. */
  function redirectShorts() {
    if (!CONFIG.hideShorts) return;
    const id = shortsId(location.pathname);
    if (id) location.replace(`/watch?v=${id}`);
  }

  // Clicking any leftover /shorts/ link opens it in the normal player instead.
  document.addEventListener("click", (e) => {
    if (!CONFIG.hideShorts || !(e.target instanceof Element)) return;
    const a = e.target.closest('a[href^="/shorts/"], a[href*="youtube.com/shorts/"]');
    const id = a && shortsId(new URL(a.href, location.origin).pathname);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const url = `/watch?v=${id}`;
    if (e.metaKey || e.ctrlKey) window.open(url, "_blank");
    else location.href = url;
  }, true);

  /* ======================================================================
   * 14. GRID LAYOUT
   *    YouTube's grids (<ytd-rich-grid-renderer>: Home, Subscriptions, channel
   *    Videos tabs…) pick tiles-per-row in JS and store it in the inline
   *    variable --ytd-rich-grid-items-per-row. We measure each grid, compute
   *    the column count the same way our Podcasts grid does (tilesPerRow, or
   *    fewer if tiles would be narrower than tileMinWidth), put it in data-ytpod-cols, and a stylesheet rule with
   *    !important (beats YouTube's inline value) applies it. YouTube also
   *    wraps tiles in row elements; "display: contents" flattens those so
   *    tiles flow freely. UNSURE: these internals.
   * ==================================================================== */

  function gridCss() {
    if (!CONFIG.uniformGrids) return "";
    // Applies to every grid from the first paint; no need to wait for JS.
    const G = "ytd-rich-grid-renderer";
    let css = `
      ${G} ytd-rich-grid-row,
      ${G} ytd-rich-grid-row > #contents { display: contents !important; }
      ${G} {
        --ytd-rich-grid-item-margin: ${CONFIG.tileGapX}px !important;
        --ytd-rich-grid-item-min-width: 0px !important;
        --ytd-rich-grid-item-max-width: 9999px !important;
      }
      ${G} ytd-rich-item-renderer { margin-bottom: ${CONFIG.tileGapY}px !important; }
    `;
    // Two mechanisms, in case YouTube no longer derives tile width from the
    // variable: set the variable AND size the grid's own tiles directly
    // (child combinators, so shelves like Shorts keep their own layout).
    const half = CONFIG.tileGapX / 2;
    const columns = (R, n) => `
      ${R} { --ytd-rich-grid-items-per-row: ${n} !important; }
      ${R} > #contents > ytd-rich-item-renderer,
      ${R} > #contents > ytd-rich-grid-row > #contents > ytd-rich-item-renderer {
        width: calc(100% / ${n} - ${CONFIG.tileGapX}px - 0.01px) !important;
        min-width: 0 !important; max-width: none !important;
        margin-left: ${half}px !important; margin-right: ${half}px !important;
      }`;

    // First paint, before JS has measured the grid: guess the column count
    // from the window width (window minus a collapsed sidebar + page margins),
    // so tiles appear at their final size straight away. Later rules win.
    const chrome = 120; // ≈ mini sidebar (72px) + grid side margins (48px)
    for (let n = 1; n <= CONFIG.tilesPerRow; n++) {
      const minWindow = n === 1 ? 0 : n * (CONFIG.tileMinWidth + CONFIG.tileGapX) - CONFIG.tileGapX + chrome;
      css += `
      @media (min-width: ${minWindow}px) {${columns(`${G}:not([data-ytpod-cols])`, n)}
      }`;
    }
    // Once measured (sizeGrid), the exact count takes over.
    for (let n = 1; n <= 12; n++) css += columns(`${G}[data-ytpod-cols="${n}"]`, n);
    return css;
  }


  const gridResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const entry of entries) sizeGrid(entry.target);
  }) : null;

  function sizeGrid(grid) {
    const width = grid.getBoundingClientRect().width;
    if (!width) return; // hidden page
    // Same rule as the Podcasts grid: tilesPerRow, fewer only if tiles would drop below tileMinWidth.
    const fit = Math.floor((width + CONFIG.tileGapX) / (CONFIG.tileMinWidth + CONFIG.tileGapX));
    const cols = String(Math.max(1, Math.min(12, CONFIG.tilesPerRow, fit)));
    if (grid.dataset.ytpodCols !== cols) grid.dataset.ytpodCols = cols;
    // Also inline (YouTube may overwrite this one; the stylesheet rule still wins).
    if (grid.style.getPropertyValue("--ytd-rich-grid-items-per-row") !== cols)
      grid.style.setProperty("--ytd-rich-grid-items-per-row", cols, "important");
  }

  function watchGrids() {
    if (!CONFIG.uniformGrids) return;
    for (const grid of document.querySelectorAll("ytd-rich-grid-renderer")) {
      if (grid.dataset.ytpodGrid) continue;
      grid.dataset.ytpodGrid = "1";
      sizeGrid(grid);
      gridResizeObserver?.observe(grid);
    }
  }

  /* ======================================================================
   * 15. BOOT
   * ==================================================================== */

  // One observer for everything: YouTube renders lazily (guide, Home tiles), so
  // we re-check at most every 500 ms while the DOM keeps changing.
  let tickTimer = 0;
  function scheduleTick() {
    if (tickTimer) return;
    tickTimer = setTimeout(() => {
      tickTimer = 0;
      ensureGuideEntries();
      watchPlayers();
      filterSettingsMenus();
      watchGrids();
      hideShortsByText();
      if (state.open) mountPage(); // in case YouTube rebuilt #page-manager
    }, 500);
  }

  function boot() {
    redirectShorts();
    injectStyles();
    storeQualityPreference();
    applyHighestQuality(); // a video may already be playing
    ensureGuideEntries();
    new MutationObserver(scheduleTick).observe(document.documentElement, { childList: true, subtree: true });
    scheduleTick(); // first pass right away, not only after the next DOM change
    if (location.hash === HASH) {
      waitFor(() => document.querySelector("#page-manager"), 10000).then(() => openPodcasts({ push: false }));
    }
    // Always printed, so you can check which version Safari is actually running.
    console.info(`[YT Tweaks] v${VERSION} running in the ${inPageWorld() ? "page" : "content"} world`);
    if (CONFIG.debug) {
      window.ytpod = { CONFIG, collectVideos, classify, parseInitialData, overrides: () => overrides, state };
    }
  }

  // Styles go in immediately (document-start: before YouTube draws anything,
  // so tiles never flash at YouTube's size first); the rest waits for <body>.
  injectStyles();
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
