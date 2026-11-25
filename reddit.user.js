// ==UserScript==
// @name         Reddit Tweaks (Narwhal-style old.reddit)
// @description  Restyles old.reddit.com into a clean, minimal, app-like layout.
// @version      1.2.7
// @updateURL    https://raw.githubusercontent.com/thombuilds/Userscripts/main/reddit.user.js
// @downloadURL  https://raw.githubusercontent.com/thombuilds/Userscripts/main/reddit.user.js
// @match        https://old.reddit.com/*
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @run-at       document-start
// ==/UserScript==

/*
 * HOW THIS FILE IS ORGANIZED
 *   0. ANTI-FLASH          – tiny style that runs first (no white flash / fades)
 *   1. CONFIG / COLORS     – the knobs you'll want to tweak
 *   2. CSS                 – injected immediately (document-start) so there's no white flash
 *   3. PAGE BEHAVIOR       – runs once the DOM is ready:
 *        3a. subreddit stylesheet removal
 *        3b. post metadata line (subreddit · time · comments) + Save / "⋯" menu
 *        3c. comment depth colors
 *        3d. click-to-collapse comments
 *        3e. split view (posts list left, opened post right)
 *        3f. link handling inside the right pane
 *        3g. favorites sidebar (right edge)
 *        3h. header: Home button, r/name with icon, user bar + menu
 *        3i. infinite scroll (loads the next page near the bottom)
 *        3j. modern touches: short times/counts, icon buttons, comment dots
 *        3k. watching for new content (new posts, "load more comments")
 *        3l. read posts (dimmed in listings)
 *
 * Every class name prefixed with "nw-" is ours (nw = Narwhal-ish), so it never
 * clashes with Reddit's own classes.
 */

(() => {
  "use strict";

  /* ----------------------------------------------------------------------
   * 0. ANTI-FLASH (runs before anything else)
   * Paint our background color immediately and switch off all transitions
   * while the page loads, so nothing visibly fades from Reddit's white to
   * our colors. Removed again once the page has finished loading.
   * -------------------------------------------------------------------- */
  const earlyStyle = document.createElement("style");
  earlyStyle.id = "nw-early";
  earlyStyle.textContent = `
    html, body { background: #e9ecf1 !important; }
    @media (prefers-color-scheme: dark) {
      html, body { background: #12141a !important; }
    }
    *, *::before, *::after { transition: none !important; }
  `;
  (document.head || document.documentElement).appendChild(earlyStyle);
  // Two frames after load, so the final styles have been drawn without animating.
  const dropEarlyStyle = () =>
    requestAnimationFrame(() => requestAnimationFrame(() => earlyStyle.remove()));
  if (document.readyState === "complete") dropEarlyStyle(); // script ran late
  else window.addEventListener("load", dropEarlyStyle);

  /* ======================================================================
   * 1. CONFIG / COLORS
   * ==================================================================== */

  const CONFIG = {
    // Remove each subreddit's custom CSS theme (it would fight our styles).
    disableSubredditStyles: true,
    // Also show the post author in the metadata line under each title.
    showAuthorInMeta: false,
    // Clicking a comment's header/body collapses it.
    clickToCollapse: true,
    // iPad-style split view: posts list on the left, opened post on the right.
    splitView: true,
    // Below this window width, split view turns off and posts open normally.
    splitMinWidth: 1000,

    // Your favorite subreddits (the sidebar on the right). This list is the
    // master copy, so it syncs to every browser through GitHub:
    //   - Editing in the sidebar (☆ add, × remove, drag to reorder) works as
    //     usual and is saved in this browser right away.
    //   - To keep those edits everywhere, click "Copy list" in the sidebar,
    //     paste the copied line over this list, bump @version and push.
    //   - Whenever this list changes (e.g. the script updates from GitHub),
    //     each browser replaces its saved list with it on the next page load.
    //     Sidebar edits you didn't copy in here are dropped at that point.
    favorites: [
      "apple", "AppleWatch", "AskReddit", "Boxing", "formula1", "ios",
      "ipad", "iphone", "LivestreamFail", "malelivingspace", "playstation",
      "PS5", "ufc", "worldnews", "2007scape", "IdleObeliskMiner",
      "naturalbodybuilding", "6nuliai",
    ],
    // Below this window width the favorites sidebar is hidden (so it never
    // covers the feed).
    favoritesMinWidth: 1200,

    // Load the next page automatically when you scroll near the bottom
    // (instead of clicking "next ›").
    infiniteScroll: true,

    // Remember which posts you've opened and dim them in listings.
    markRead: true,
  };

  // Read posts (3l): fullname → time opened, kept for 30 days.
  const READ_KEY = "nw-read-v1";
  const READ_DAYS = 30;

  // True when this page is running inside the split view's right pane.
  const IN_PANE = window.top !== window.self;
  if (IN_PANE) document.documentElement.classList.add("nw-in-pane");

  // Old Reddit refuses to send any request (comment save, votes, save…)
  // from inside an iframe, as anti-clickjacking protection: its $.request
  // silently returns unless `reddit.external_frame` is set. Our pane is an
  // iframe on the same site, so set that flag in the page's own JS (the
  // userscript's `window` may be a separate sandbox, hence the <script>).
  if (IN_PANE) {
    const allowFrame = document.createElement("script");
    allowFrame.textContent = `(() => {
      const set = () => {
        if (window.r && r.config) r.config.external_frame = true;
        if (window.reddit) window.reddit.external_frame = true;
      };
      set();
      document.addEventListener("DOMContentLoaded", set);
      window.addEventListener("load", set);
    })();`;
    (document.head || document.documentElement).appendChild(allowFrame);
    allowFrame.remove();
  }

  // Guess the layout right away (from the URL and window width), so the page
  // doesn't render centered first and then jump left. Section 3e/3g correct
  // the guess once the page has loaded.
  const NOT_A_LISTING = /\/(comments|prefs|message|submit|wiki|settings|login|register|search)\b/i;
  if (!IN_PANE) {
    const wideFor = (px) => window.matchMedia(`(min-width: ${px}px)`).matches;
    if (CONFIG.splitView && !NOT_A_LISTING.test(location.pathname) && wideFor(CONFIG.splitMinWidth)) {
      document.documentElement.classList.add("nw-split");
    }
    if (wideFor(CONFIG.favoritesMinWidth)) {
      document.documentElement.classList.add("nw-favs-on");
    }
  }

  // Arriving at a post from outside Reddit (Google, another app, a bookmark):
  // go to that subreddit's listing instead and open the post in the right
  // pane (section 3e picks it up), so the posts list is there on the left.
  // Posts reached from Reddit itself (e.g. "Open ↗" in the pane) stay full pages.
  const OPEN_IN_PANE_KEY = "nw-open-in-pane";
  let redirecting = false;

  // { sub, id } when this page is a post we should redirect away from.
  function postToRedirect() {
    if (IN_PANE || !CONFIG.splitView) return null;
    if (!window.matchMedia(`(min-width: ${CONFIG.splitMinWidth}px)`).matches) return null;
    const m = location.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
    if (!m) return null;
    try {
      if (document.referrer && /(^|\.)reddit\.com$/.test(new URL(document.referrer).hostname)) return null;
    } catch (err) { /* bad referrer → treat as outside */ }
    return { sub: m[1], id: m[2] };
  }

  function redirectToListing(target) {
    try {
      sessionStorage.setItem(OPEN_IN_PANE_KEY, JSON.stringify({ url: location.href, id: target.id }));
    } catch (err) {
      return false; // storage blocked: just show the post normally
    }
    redirecting = true;
    location.replace(`/r/${target.sub}/`);
    return true;
  }

  const redirectTarget = postToRedirect();
  if (redirectTarget) {
    // Keep the post page invisible while we leave it, so it never shows up
    // centered first. (Removed again if we end up staying.)
    const hide = document.createElement("style");
    hide.textContent = "body { visibility: hidden !important; }";
    (document.head || document.documentElement).appendChild(hide);
    const stay = () => hide.remove();
    setTimeout(() => { if (!redirecting) stay(); }, 4000); // safety net

    // old.reddit.com is always the old design: go right away.
    // www.reddit.com can be either. Old Reddit's <body> carries the class
    // "comments-page" on posts, so decide the moment <body> appears instead
    // of waiting for the whole page (and all its comments) to load.
    const decide = () => {
      const old = location.hostname === "old.reddit.com" ||
        document.body.classList.contains("comments-page");
      if (!(old && redirectToListing(redirectTarget))) stay();
    };
    if (location.hostname === "old.reddit.com" || document.body) {
      decide();
    } else {
      const bodyWatch = new MutationObserver(() => {
        if (!document.body) return;
        bodyWatch.disconnect();
        decide();
      });
      bodyWatch.observe(document.documentElement, { childList: true });
    }
    if (redirecting) return;
  }

  // Landing on the listing after such a redirect: start loading the post in
  // the right pane as soon as <body> exists, while the list is still loading
  // (section 3e finishes the job once the page is ready).
  function peekPendingPost() {
    try {
      const pending = JSON.parse(sessionStorage.getItem(OPEN_IN_PANE_KEY) || "null");
      return pending && pending.url ? pending : null;
    } catch (err) {
      return null;
    }
  }
  if (!IN_PANE && document.documentElement.classList.contains("nw-split") && peekPendingPost()) {
    // Deferred, so the pane variables further down are defined.
    const start = () => setTimeout(() => {
      if (!pane) buildPane();
      const pending = peekPendingPost();
      if (pending) openInPane(paneUrlOf(pending), null);
    }, 0);
    if (document.body) {
      start();
    } else {
      const bodyWatch = new MutationObserver(() => {
        if (!document.body) return;
        bodyWatch.disconnect();
        start();
      });
      bodyWatch.observe(document.documentElement, { childList: true });
    }
  }

  // All colors and sizes live here as CSS variables. Change values, save, reload.
  const THEME_VARS = `
    :root {
      /* Page background: soft cool-gray gradient (stays put while scrolling) */
      --nw-bg:          #e9ecf1;   /* solid fallback / pane background */
      --nw-bg-gradient: linear-gradient(160deg, #f6f7fa 0%, #e8ebf0 45%, #dce0e7 100%);

      /* "Frosted glass" surfaces: semi-transparent white + blur + soft shadow */
      --nw-card:        rgba(255, 255, 255, 0.72);   /* post card background */
      --nw-card-hover:  rgba(255, 255, 255, 0.92);
      --nw-glass-edge:  rgba(255, 255, 255, 0.7);    /* light rim around cards */
      --nw-blur:        blur(14px) saturate(140%);
      --nw-shadow:       0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 14px rgba(15, 23, 42, 0.06);
      --nw-shadow-hover: 0 2px 4px rgba(15, 23, 42, 0.05), 0 8px 24px rgba(15, 23, 42, 0.10);

      --nw-separator:   rgba(15, 23, 42, 0.08);   /* thin lines between things */
      --nw-text:        #1e2430;   /* main text (slate, softer than black) */
      --nw-text-muted:  #64748b;   /* metadata, buttons */
      --nw-text-faint:  #a0aab8;   /* very low-emphasis text */
      --nw-accent:      #4f5fe8;   /* the one accent color (indigo-blue) */
      --nw-visited:     #8a94a6;   /* titles of posts you've already opened */
      --nw-input-bg:    rgba(255, 255, 255, 0.85);   /* text boxes */
      --nw-fill:        rgba(15, 23, 42, 0.05);   /* flair pills, code blocks, secondary buttons */
      --nw-header-bg:   rgba(246, 247, 250, 0.72);  /* sticky frosted header */
      --nw-sidebar-bg:  rgba(255, 255, 255, 0.55);  /* favorites sidebar */
      --nw-green:       #248a3d;   /* pinned posts, moderators */
      --nw-red:         #ff3b30;   /* admins */
      --nw-upvote:      #ff6a00;   /* your upvote */
      --nw-downvote:    #6b7cff;   /* your downvote */

      /* Comment depth lines – cycles through these 6 */
      --nw-depth-1: #4f5fe8;  /* indigo */
      --nw-depth-2: #34c759;  /* green  */
      --nw-depth-3: #ffb300;  /* yellow */
      --nw-depth-4: #ff9500;  /* orange */
      --nw-depth-5: #ff2d55;  /* pink   */
      --nw-depth-6: #af52de;  /* purple */

      --nw-feed-width:  720px;   /* feed width when split view is off */
      --nw-list-width:  440px;   /* left posts column in split view */
      --nw-pane-width:  860px;   /* max content width inside the right pane */
      --nw-radius:      16px;
      --nw-thumb-size:  64px;
      --nw-fav-width:   220px;   /* favorites sidebar on the right */
      --nw-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      color-scheme: light;
    }

    /* Dark set: used automatically when macOS is in Dark Mode. */
    @media (prefers-color-scheme: dark) {
      :root {
        --nw-bg:          #12141a;
        --nw-bg-gradient: linear-gradient(160deg, #0f1115 0%, #161920 45%, #1c2029 100%);
        --nw-card:        rgba(32, 36, 45, 0.72);
        --nw-card-hover:  rgba(40, 45, 56, 0.92);
        --nw-glass-edge:  rgba(255, 255, 255, 0.06);
        --nw-shadow:       0 1px 2px rgba(0, 0, 0, 0.30), 0 4px 14px rgba(0, 0, 0, 0.25);
        --nw-shadow-hover: 0 2px 4px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.35);
        --nw-separator:   rgba(255, 255, 255, 0.08);
        --nw-text:        #e6e8ee;
        --nw-text-muted:  #9aa3b2;
        --nw-text-faint:  #5f6878;
        --nw-accent:      #7c8cff;
        --nw-visited:     #7d8597;
        --nw-input-bg:    rgba(255, 255, 255, 0.06);
        --nw-fill:        rgba(255, 255, 255, 0.07);
        --nw-header-bg:   rgba(15, 17, 21, 0.72);
        --nw-sidebar-bg:  rgba(24, 27, 34, 0.60);
        --nw-green:       #4ade80;
        --nw-red:         #ff6b6b;
        --nw-upvote:      #ff8a3d;
        --nw-downvote:    #8f9cff;
        --nw-depth-1: #7c8cff;
        color-scheme: dark;
      }
    }
  `;

  // Small line icons for the share / save / hide / report buttons (3j)
  // and the card actions (3b).
  // Drawn as CSS masks, so they take the link's text color.
  const svgIcon = (body, fill = "none") =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='${fill}' stroke='black' ` +
      `stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`
    )}")`;
  const BOOKMARK = "<path d='M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'/>";
  const STAR = "<path d='M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z'/>";
  const ICONS = {
    share: svgIcon("<path d='M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7'/><path d='M16 6l-4-4-4 4'/><path d='M12 2v14'/>"),
    save: svgIcon(BOOKMARK),
    saved: svgIcon(BOOKMARK, "black"),
    hide: svgIcon("<path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94'/><path d='M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19'/><path d='M14.12 14.12a3 3 0 1 1-4.24-4.24'/><path d='M1 1l22 22'/>"),
    report: svgIcon("<path d='M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z'/><path d='M4 22v-7'/>"),
    text: svgIcon("<path d='M4 6h16'/><path d='M4 12h16'/><path d='M4 18h10'/>"),
    play: svgIcon("<path d='M7 4l13 8-13 8z'/>"),
    collapse: svgIcon("<path d='M6 15l6-6 6 6'/>"),
    more: svgIcon("<circle cx='5' cy='12' r='1.6'/><circle cx='12' cy='12' r='1.6'/><circle cx='19' cy='12' r='1.6'/>", "black"),
    crosspost: svgIcon("<path d='M17 1l4 4-4 4'/><path d='M3 11V9a4 4 0 0 1 4-4h14'/><path d='M7 23l-4-4 4-4'/><path d='M21 13v2a4 4 0 0 1-4 4H3'/>"),
    // Header (3h)
    home: svgIcon("<path d='M3 10.5L12 3l9 7.5'/><path d='M5 9v11h5v-6h4v6h5V9'/>"),
    star: svgIcon(STAR),
    starred: svgIcon(STAR, "black"),
    mail: svgIcon("<rect x='3' y='5' width='18' height='14' rx='2'/><path d='M3 7l9 6 9-6'/>"),
    modmail: svgIcon("<path d='M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z'/>"),
    bell: svgIcon("<path d='M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'/><path d='M13.7 21a2 2 0 0 1-3.4 0'/>"),
    chat: svgIcon("<path d='M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z'/>"),
    user: svgIcon("<circle cx='12' cy='8' r='4'/><path d='M4 21a8 8 0 0 1 16 0'/>"),
    prefs: svgIcon("<path d='M4 6h9'/><path d='M19 6h1'/><circle cx='16' cy='6' r='2.5'/><path d='M4 12h2'/><path d='M12 12h8'/><circle cx='9' cy='12' r='2.5'/><path d='M4 18h11'/><circle cx='18' cy='18' r='2.5'/>"),
    logout: svgIcon("<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'/><path d='M16 17l5-5-5-5'/><path d='M21 12H9'/>"),
    chevron: svgIcon("<path d='M6 9l6 6 6-6'/>"),
  };

  /* ======================================================================
   * 2. CSS
   * ==================================================================== */

  const CSS = `
    ${THEME_VARS}

    /* ---------- 2.1 Base page ---------------------------------------- */
    html {
      background: var(--nw-bg-gradient) fixed !important;
      min-height: 100%;
    }
    html, body {
      color: var(--nw-text) !important;
    }
    body { background: transparent !important; }
    body, body input, body textarea, body select, body button, .md {
      font-family: var(--nw-font) !important;
    }
    body { font-size: 14px !important; }
    a { color: var(--nw-accent); }

    /* ---------- 2.2 Hide clutter ------------------------------------- */
    .side,                                   /* right sidebar (incl. submit boxes) */
    .footer-parent, .debuginfo,              /* footer */
    #ad_main, .ad-container, #ad-frame,      /* ads */
    .sponsorshipbox,
    .thing.promoted, .thing.promotedlink,    /* promoted posts */
    .organic-listing, #siteTable_organic,    /* old "spotlight" box */
    .awardings-bar, .awarding-link,          /* award icons */
    .awarding-icon, .gilded-icon,
    .give-gold-button,                       /* "give award" button */
    .sidebox.submit, .sidebox.create,        /* submit boxes (if outside .side) */
    .listingsignupbar,                       /* "sign up" bar */
    .premium-banner-outer,                   /* UNSURE: premium nag */
    .redesign-beta-optin, #redesign-beta-optin-btn,  /* UNSURE: "try new reddit" */
    .listing-chooser, .grippy,               /* left "home / multireddits" sidebar */
    #sr-header-area,                         /* top bar: MY SUBREDDITS · HOME · POPULAR… */
    .thing.link > .rank,                     /* the 1, 2, 3 rank numbers */
    img#header-img,                          /* subreddit custom banner image */
    html.nw-home-ready #header-img,          /* Reddit's logo / banner link… */
    html.nw-home-ready #header-img-a         /* …replaced by our Home link (3h) */
    { display: none !important; }

    /* Reddit shifts the page right to make room for that sidebar
       (body.with-listing-chooser). Undo the shift. */
    body.with-listing-chooser #header .tabmenu,
    body.with-listing-chooser #header .pagename,
    body.with-listing-chooser #header-bottom-left {
      padding-left: 0 !important;
    }
    /* (.content's shift is already overridden by section 2.4's margin/padding.) */
    body.with-listing-chooser #header .tabmenu,
    body.with-listing-chooser #header .pagename {
      margin-left: 0 !important;
    }

    /* ---------- 2.3 Header (kept for navigation, just restyled) ------- */
    /* Sticky frosted header: stays at the top, content blurs underneath */
    #header {
      position: sticky !important;
      top: 0;
      z-index: 900;
      background: var(--nw-header-bg) !important;
      background-image: none !important;
      -webkit-backdrop-filter: var(--nw-blur);
      backdrop-filter: var(--nw-blur);
      border-bottom: 1px solid var(--nw-separator) !important;
      padding-bottom: 6px;
    }
    /* Header layout (built by JS, 3h):
         [Home] [icon r/name ☆] ........ [mail 🔔 💬 🛡 user ▾]
         [Home] [hot | new | top …]
       Home is big and spans both rows. Missing pieces just leave a gap. */
    #header-bottom-left {
      max-width: var(--nw-feed-width);
      margin: 0 auto !important;
      float: none !important;
      position: static !important;
      box-sizing: border-box;
      padding: 8px 12px 0 !important;
      display: grid !important;
      grid-template-columns: auto minmax(0, max-content) auto minmax(0, 1fr) auto;
      grid-template-areas:
        "home name star . user"
        "home tabs tabs tabs tabs";
      align-items: center;
      gap: 8px 10px;
    }
    #header-bottom-left > * { min-width: 0; }
    #header-bottom-left > .nw-home        { grid-area: home; }
    #header-bottom-left > .pagename       { grid-area: name; min-width: 0; }
    #header-bottom-left > .nw-fav-toggle  { grid-area: star; }
    #header-bottom-left > .nw-user        { grid-area: user; justify-self: end; }
    #header-bottom-left > .tabmenu        { grid-area: tabs; justify-self: start; max-width: 100%; box-sizing: border-box; }
    /* More tabs than fit: scroll sideways instead of running off the edge */
    #header .tabmenu { overflow-x: auto; scrollbar-width: none; }
    #header .tabmenu::-webkit-scrollbar { display: none; }
    #header .tabmenu li { flex: none; }
    .pagename.nw-sub-title a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #header-bottom-left > * { margin-top: 0 !important; margin-bottom: 0 !important; }
    .pagename { margin: 0 !important; padding: 0 !important; line-height: 1 !important; display: inline-flex; align-items: center; }
    .pagename a { color: var(--nw-text) !important; font-size: 18px; font-weight: 700; line-height: 1; }

    /* Subreddit name in normal case ("r/macOS", not small caps) with its icon */
    .pagename, .pagename a { font-variant: normal !important; text-transform: none !important; }
    .pagename.nw-sub-title { gap: 8px; }
    .pagename.nw-sub-title a::before { content: "r/"; color: var(--nw-text-muted); font-weight: 600; }

    /* Round icon buttons in the header: Home, mail… and the ☆ (JS 3h, 3g) */
    .nw-hbtn, .nw-fav-toggle {
      position: relative;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      box-sizing: border-box;
      margin: 0;
      padding: 0 !important;
      border: none !important;
      border-radius: 50% !important;
      background: var(--nw-fill) !important;
      color: var(--nw-text-muted) !important;
      text-decoration: none !important;
      cursor: pointer;
    }
    .nw-hbtn::before, .nw-fav-toggle::before, .nw-user-chip::after {
      content: "";
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      background-color: currentColor;
      -webkit-mask: var(--nw-icon) center / contain no-repeat;
      mask: var(--nw-icon) center / contain no-repeat;
    }
    .nw-hbtn:hover, .nw-fav-toggle:hover {
      background: color-mix(in srgb, var(--nw-accent) 14%, transparent) !important;
      color: var(--nw-accent) !important;
    }
    .nw-hbtn:focus-visible, .nw-fav-toggle:focus-visible, .nw-user-chip:focus-visible {
      outline: 2px solid var(--nw-accent);
      outline-offset: 1px;
    }
    .nw-home         { --nw-icon: ${ICONS.home}; width: 46px !important; height: 46px !important; }
    .nw-home::before { width: 22px; height: 22px; }
    .nw-hbtn-mail    { --nw-icon: ${ICONS.mail}; }
    .nw-hbtn-modmail { --nw-icon: ${ICONS.modmail}; }
    .nw-hbtn-chat    { --nw-icon: ${ICONS.chat}; }
    .nw-hbtn-bell    { --nw-icon: ${ICONS.bell}; }
    /* A link we don't recognise: Reddit's own icon, in the same round button */
    .nw-hbtn-raw::before { display: none; }
    .nw-hbtn-raw > a { display: block; margin: 0 !important; }
    /* Empty bits Reddit leaves in the header row (JS 3h) */
    .nw-gone { display: none !important; }
    .nw-hbtn.nw-unread { color: var(--nw-accent) !important; }

    /* Unread badge: a dot, or the count when Reddit shows one */
    .nw-badge {
      position: absolute;
      top: -1px;
      right: -1px;
      min-width: 10px;
      height: 10px;
      box-sizing: border-box;
      border-radius: 999px;
      border: 2px solid var(--nw-bg);
      background: var(--nw-accent);
      color: #fff;
      font: 700 9px/12px var(--nw-font);
      text-align: center;
    }
    .nw-badge:not(:empty) { height: 16px; min-width: 16px; padding: 0 3px; top: -4px; right: -5px; }

    /* ☆ / ★ right after the subreddit name: bare icon until hovered */
    .nw-fav-toggle {
      background: none !important;
      margin-left: -6px !important;
      --nw-icon: ${ICONS.star};
    }
    .nw-fav-toggle.nw-on { --nw-icon: ${ICONS.starred}; color: var(--nw-accent) !important; }

    /* User bar: [mail] [modmail] [avatar name ▾] at the end of the row.
       Reddit's own box is hidden once ours is built (logged out it stays). */
    html.nw-user-ready #header-bottom-right { display: none !important; }
    .nw-user {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto !important;
      min-width: 0;
    }
    .nw-user-chip {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      max-width: 220px;
      height: 30px;
      box-sizing: border-box;
      padding: 0 9px 0 3px !important;
      border: none !important;
      border-radius: 999px !important;
      background: var(--nw-fill) !important;
      color: var(--nw-text) !important;
      font: 600 13px/1 var(--nw-font) !important;
      cursor: pointer;
      --nw-icon: ${ICONS.chevron};
    }
    .nw-user-chip::after { width: 12px; height: 12px; opacity: 0.55; }
    .nw-user-chip:hover, .nw-user-chip[aria-expanded="true"] {
      background: color-mix(in srgb, var(--nw-accent) 14%, transparent) !important;
      color: var(--nw-accent) !important;
    }
    .nw-user-avatar {
      flex: none;
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      color: #fff;
      font: 700 12px/1 var(--nw-font);
    }
    .nw-user-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    #header-bottom-right {
      background: var(--nw-card) !important;
      border-radius: 0 0 0 10px !important;
      color: var(--nw-text-muted) !important;
    }
    #header-bottom-right a { color: var(--nw-accent) !important; }
    /* User bar: same size/weight as the rest of the header */
    #header-bottom-right,
    #header-bottom-right * {
      font: 500 13px/18px var(--nw-font) !important;
    }
    #header-bottom-right .userkarma { color: var(--nw-text-muted) !important; }
    #header-bottom-right .separator { color: var(--nw-separator) !important; }

    /* Hot / New / Top as a pill-shaped segmented control */
    #header .tabmenu {
      display: inline-flex !important;
      align-items: center;
      gap: 2px;
      margin: 0 !important;
      padding: 3px !important;
      background: var(--nw-fill);
      border-radius: 999px;
      vertical-align: middle;
    }
    #header .tabmenu li { margin: 0 !important; padding: 0 !important; }
    #header .tabmenu li a {
      display: block;
      padding: 4px 12px !important;
      border-radius: 999px !important;
      background: transparent !important;
      color: var(--nw-text-muted) !important;
      border: none !important;
      font-weight: 600;
      font-size: 13px;
      text-decoration: none !important;
      transition: background 0.15s, color 0.15s;
    }
    #header .tabmenu li a:hover { color: var(--nw-text) !important; }
    #header .tabmenu li.selected a {
      background: var(--nw-card-hover) !important;
      color: var(--nw-accent) !important;
      box-shadow: var(--nw-shadow);
    }

    /* Dropdown menus (sort by, etc.) */
    .drop-choices {
      background: var(--nw-card-hover) !important;
      -webkit-backdrop-filter: var(--nw-blur);
      backdrop-filter: var(--nw-blur);
      border: 1px solid var(--nw-separator) !important;
      border-radius: 10px;
    }
    .drop-choices { padding: 4px 0 !important; }
    .drop-choices a.choice {
      color: var(--nw-text) !important;
      font: 500 13px/18px var(--nw-font) !important;
      padding: 4px 12px !important;
    }
    /* "links from: past month" row */
    .menuarea, .menuarea .dropdown, .menuarea .dropdown .selected {
      font: 500 13px/18px var(--nw-font) !important;
    }
    .drop-choices a.choice:hover { background: var(--nw-card-hover) !important; }
    .dropdown.lightdrop .selected { color: var(--nw-accent) !important; }

    /* Info bars (e.g. "you are viewing a single comment's thread") */
    .infobar, .menuarea, .panestack-title {
      background: transparent !important;
      border-color: var(--nw-separator) !important;
      color: var(--nw-text-muted) !important;
    }

    /* ---------- 2.4 Centered feed ------------------------------------ */
    body > .content {
      max-width: var(--nw-feed-width) !important;
      margin: 12px auto 40px !important;
      padding: 0 12px !important;
      box-sizing: border-box;
      float: none !important;
    }

    /* ---------- 2.5 Post cards --------------------------------------- */
    /* Flexbox lets us reorder: [votes] [title + meta] [thumbnail on the right] */
    .thing.link {
      display: flex !important;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 12px;
      background: var(--nw-card) !important;
      border: none !important;                 /* shadow only */
      border-radius: var(--nw-radius) !important;
      box-shadow: var(--nw-shadow);
      -webkit-backdrop-filter: var(--nw-blur);
      backdrop-filter: var(--nw-blur);
      padding: 12px 14px 10px !important;      /* a little tighter at the bottom */
      margin: 0 0 10px 0 !important;           /* gap between cards */
      position: relative;
      transition: background 0.15s, box-shadow 0.15s, transform 0.15s, opacity 0.15s;
    }
    .thing.link:hover {
      background: var(--nw-card-hover) !important;
      box-shadow: var(--nw-shadow-hover);
      transform: translateY(-1px);   /* tiny lift */
    }
    .thing.link > .parent    { display: none; }
    .thing.link > .midcol    { order: 0; margin: 0 !important; float: none !important; }
    .thing.link > .entry     { order: 1; flex: 1 1 0; min-width: 0; margin: 0 !important; }
    .thing.link > .thumbnail { order: 2; float: none !important; margin: 0 !important; }
    .thing.link > .child     { order: 3; flex-basis: 100%; }

    /* Titles */
    .thing.link .title { margin: 0 !important; }
    .thing.link a.title {
      color: var(--nw-text) !important;
      font-size: 16px !important;
      font-weight: 600 !important;
      line-height: 1.3 !important;
    }
    .thing.link a.title:visited { color: var(--nw-visited) !important; }
    .thing.link.stickied a.title { color: var(--nw-green) !important; }  /* pinned posts */
    .thing.link .domain,
    .thing.link .domain a { color: var(--nw-text-faint) !important; font-size: 12px !important; }

    /* Link flair pill (e.g. "Discussion") */
    .linkflairlabel {
      background: var(--nw-fill) !important;
      color: var(--nw-text-muted) !important;
      border: none !important;
      border-radius: 6px !important;
      padding: 1px 6px !important;
    }

    /* Thumbnails: rounded, on the right */
    .thing.link a.thumbnail img {
      width: var(--nw-thumb-size) !important;
      height: var(--nw-thumb-size) !important;
      object-fit: cover;
      border-radius: 12px;
      display: block;
    }
    .thing.link a.thumbnail.self,     /* generic "text post" icon */
    .thing.link a.thumbnail.default   /* generic "link" icon */
    { display: none !important; }
    .thing.link a.thumbnail { border-radius: 12px; overflow: hidden; }

    /* ---------- 2.6 Metadata line ------------------------------------ */
    /* Our own line, built by JS (section 3b). Until JS runs, Reddit's
       original tagline stays visible as a fallback.
       One flex row that never wraps:
       [expand] r/sub · 3h · 12 comments ............ [save] [⋯]
       Only the subreddit name shrinks (with an ellipsis) when space is tight. */
    .nw-meta {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      min-width: 0;
      margin: 4px 0 0;
      padding: 0;
      font-size: 12px;
      line-height: 16px;
      white-space: nowrap;
      color: var(--nw-text-muted);
    }
    /* Text items: identical size/line-height, no stray spacing from Reddit. */
    .nw-meta > :is(a, time, span.nw-sep) {
      flex: 0 0 auto;
      font-size: inherit !important;
      line-height: inherit !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      vertical-align: baseline !important;
      float: none !important;
      white-space: nowrap !important;
    }
    .nw-meta > a, .nw-meta > time { color: var(--nw-text-muted) !important; }
    .nw-meta > a:hover { color: var(--nw-accent) !important; }
    .nw-meta > a.subreddit {
      flex: 0 1 auto;          /* the only item allowed to shrink */
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 600;
    }
    .nw-meta > span.nw-sep { margin: 0 5px !important; color: var(--nw-text-faint); }
    /* Reddit's expand button, moved to the start of the row (JS 3b). */
    .nw-meta > .expando-button {
      flex: 0 0 auto;
      float: none !important;
      width: 18px !important;
      height: 18px !important;
      margin: -1px 6px -1px 0 !important;   /* takes 16px of row height */
      border-radius: 6px;
    }
    .nw-meta > .expando-button::before { width: 11px; height: 11px; }

    .thing.link.nw-meta-ready > .entry .tagline { display: none !important; }
    .thing.link.nw-meta-ready .buttons li.first { display: none !important; }

    /* Original tagline (fallback / comment headers) */
    .tagline, .tagline a, .tagline time {
      color: var(--nw-text-muted) !important;
      font-size: 12px !important;
    }

    /* ---------- 2.6b Card actions: Save + "⋯" menu ------------------- */
    /* Right end of the metadata row. They click Reddit's original links. */
    .nw-actions {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 2px;
      margin-left: auto;
      padding-left: 8px;
    }
    .nw-act {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 22px;
      height: 20px;
      margin: -2px 0;                       /* takes 16px of row height */
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: none;
      color: var(--nw-text-muted);
      cursor: pointer;
    }
    .nw-act::before, .nw-menu-item::before {
      content: "";
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      background-color: currentColor;
      -webkit-mask: var(--nw-icon) center / contain no-repeat;
      mask: var(--nw-icon) center / contain no-repeat;
    }
    .nw-act:hover, .nw-act[aria-expanded="true"] {
      background: var(--nw-fill);
      color: var(--nw-accent);
    }
    .nw-act:focus-visible { outline: 2px solid var(--nw-accent); outline-offset: 1px; }
    .nw-act-save { --nw-icon: ${ICONS.save}; }
    .nw-act-save[aria-pressed="true"] { --nw-icon: ${ICONS.saved}; color: var(--nw-accent); }
    .nw-act-more { --nw-icon: ${ICONS.more}; }

    /* Reddit's own action row is kept in the page (we click its links)
       but its items are hidden on cards that have our actions. */
    .thing.link.nw-has-actions .buttons {
      display: block !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .thing.link.nw-has-actions .buttons > li { display: none !important; }

    /* The "⋯" popover (one at a time, attached to <body>). */
    .nw-menu {
      position: fixed;
      z-index: 2147483000;
      min-width: 150px;
      padding: 4px;
      box-sizing: border-box;
      background: var(--nw-card-hover);
      -webkit-backdrop-filter: var(--nw-blur);
      backdrop-filter: var(--nw-blur);
      border-radius: 12px;
      box-shadow: var(--nw-shadow-hover);
      font: 13px/18px var(--nw-font);
    }
    .nw-menu-item {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 10px;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--nw-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    a.nw-menu-item { box-sizing: border-box; text-decoration: none; }
    .nw-menu-note {
      padding: 6px 10px 6px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--nw-separator);
      color: var(--nw-text-muted);
      font-size: 12px;
    }
    .nw-icon-user   { --nw-icon: ${ICONS.user}; }
    .nw-icon-prefs  { --nw-icon: ${ICONS.prefs}; }
    .nw-icon-logout { --nw-icon: ${ICONS.logout}; }
    .nw-menu-item::before { color: var(--nw-text-muted); }
    .nw-menu-item:hover, .nw-menu-item:focus-visible {
      background: var(--nw-fill);
      color: var(--nw-accent);
      outline: none;
    }
    .nw-menu-item:hover::before, .nw-menu-item:focus-visible::before { color: var(--nw-accent); }

    /* Reddit's action row on the post's own page (no card actions there). */
    .thing.link.nw-meta-ready:not(.nw-has-actions) .buttons {
      display: inline-flex !important;
      align-items: center;
      gap: 2px;
      margin: 4px 0 0 !important;
      padding: 0 !important;
    }
    .thing.link .buttons li { padding: 0 !important; margin: 0 !important; }

    /* Icon buttons (JS 3j tags the links). The original text stays in the
       link (hidden), so Reddit's save/unsave text swaps keep working. */
    .thing .buttons li a.nw-icon {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 8px;
      font-size: 0 !important;
      color: var(--nw-text-muted) !important;
    }
    .thing .buttons li a.nw-icon::before {
      content: "";
      width: 15px;
      height: 15px;
      background-color: currentColor;
      -webkit-mask: var(--nw-icon) center / contain no-repeat;
      mask: var(--nw-icon) center / contain no-repeat;
    }
    .thing .buttons li a.nw-icon:hover {
      background: var(--nw-fill);
      color: var(--nw-accent) !important;
    }
    .nw-icon-share     { --nw-icon: ${ICONS.share}; }
    .nw-icon-save      { --nw-icon: ${ICONS.save}; }
    .nw-icon-hide      { --nw-icon: ${ICONS.hide}; }
    .nw-icon-report    { --nw-icon: ${ICONS.report}; }
    .nw-icon-crosspost { --nw-icon: ${ICONS.crosspost}; }
    .thing.saved .buttons li a.nw-icon-save {      /* filled when saved */
      --nw-icon: ${ICONS.saved};
      color: var(--nw-accent) !important;
    }

    /* Reddit's "expand" button (text / video / crosspost preview): redrawn
       as an icon in the same style as the card action icons. */
    .thing .expando-button {
      background: var(--nw-fill) !important;
      background-image: none !important;
      width: 22px !important;
      height: 22px !important;
      margin: 4px 6px 0 0 !important;
      border-radius: 7px;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      color: var(--nw-text-muted);
      cursor: pointer;
      --nw-icon: ${ICONS.play};
    }
    .thing .expando-button.selftext  { --nw-icon: ${ICONS.text}; }
    .thing .expando-button.crosspost { --nw-icon: ${ICONS.crosspost}; }
    .thing .expando-button.expanded  { --nw-icon: ${ICONS.collapse}; color: var(--nw-accent); }
    .thing .expando-button::before {
      content: "";
      width: 13px;
      height: 13px;
      background-color: currentColor;
      -webkit-mask: var(--nw-icon) center / contain no-repeat;
      mask: var(--nw-icon) center / contain no-repeat;
    }
    .thing .expando-button:hover { color: var(--nw-accent); }

    /* Self-text and media expanded inside a card */
    .thing.link .expando { margin: 8px 0 0 !important; }
    .link .usertext-body .md {
      background: transparent !important;
      border: none !important;
      padding: 0 !important;
      max-width: none !important;
    }

    /* ---------- 2.7 Votes -------------------------------------------- */
    .midcol .arrow {
      opacity: 0.3;
      transition: opacity 0.15s;
    }
    .thing:hover > .midcol .arrow,
    .thing:hover .nw-vote .arrow { opacity: 0.7; }
    .midcol .arrow:hover,
    .midcol .arrow.upmod,          /* you upvoted */
    .midcol .arrow.downmod         /* you downvoted */
    { opacity: 1 !important; }
    .midcol .score { color: var(--nw-text-muted) !important; }
    .midcol .score.likes    { color: var(--nw-upvote) !important; }
    .midcol .score.dislikes { color: var(--nw-downvote) !important; }

    /* Vertical vote pill on the left ( ▲ / score / ▼ ). It's Reddit's own
       vote column (.midcol), just restyled, so voting is untouched. */
    .thing.link .midcol.nw-vote {
      display: flex !important;
      flex-direction: column !important;
      align-items: center;
      align-self: flex-start;
      gap: 4px;
      width: auto !important;
      min-width: 34px !important;
      float: none !important;
      margin: 0 !important;
      padding: 6px 4px !important;
      box-sizing: border-box;
      border-radius: 999px;
      background: var(--nw-fill);
      order: 0;
    }
    .nw-vote .arrow {
      display: inline-block !important;
      width: auto !important;
      height: auto !important;
      margin: 0 !important;
      background: none !important;      /* drop Reddit's sprite image */
      font-size: 10px;
      line-height: 1;
      color: var(--nw-text-muted);
      cursor: pointer;
    }
    .nw-vote .arrow.up::before,   .nw-vote .arrow.upmod::before   { content: "▲"; }
    .nw-vote .arrow.down::before, .nw-vote .arrow.downmod::before { content: "▼"; }
    .nw-vote .arrow.upmod   { color: var(--nw-upvote); }
    .nw-vote .arrow.downmod { color: var(--nw-downvote); }
    /* Show the score that matches your vote, read from the arrows' state. */
    .nw-vote .score {
      display: none !important;
      width: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      font-size: 12px !important;
      font-weight: 600;
      line-height: 1;
      color: var(--nw-text) !important;
    }
    .nw-vote:not(:has(.arrow.upmod)):not(:has(.arrow.downmod)) .score.unvoted,
    .nw-vote:has(.arrow.upmod) .score.likes,
    .nw-vote:has(.arrow.downmod) .score.dislikes { display: inline !important; }
    .nw-vote:has(.arrow.upmod) .score.likes        { color: var(--nw-upvote) !important; }
    .nw-vote:has(.arrow.downmod) .score.dislikes   { color: var(--nw-downvote) !important; }

    /* ---------- 2.8 Text, quotes, code (posts & comments) ------------ */
    .md {
      font-size: 15px !important;
      line-height: 1.55 !important;
      color: var(--nw-text) !important;
    }
    .md p { margin-bottom: 0.6em !important; }
    .md a { color: var(--nw-accent) !important; }
    .md blockquote {
      border-left: 3px solid var(--nw-separator) !important;
      color: var(--nw-text-muted) !important;
      padding-left: 10px !important;
    }
    .md code, .md pre {
      background: var(--nw-fill) !important;
      color: var(--nw-text) !important;
      border: 1px solid var(--nw-separator) !important;
      border-radius: 6px !important;
    }
    .md hr { border-color: var(--nw-separator) !important; }
    .md table th, .md table td { border-color: var(--nw-separator) !important; }

    /* ---------- 2.9 Comments ----------------------------------------- */
    .commentarea { margin-top: 16px; }

    /* Top-level comments separated by a thin line */
    .commentarea > .sitetable > .thing.comment {
      border-top: 1px solid var(--nw-separator);
      padding-top: 10px !important;
      margin-top: 8px !important;
    }

    /* Remove Reddit's dotted reply lines; ours replace them */
    .comment .child, .comment .showreplies {
      border-left: none !important;
      margin-left: 8px !important;
    }

    /* Nested comments get a colored line. JS (3c) sets data-nw-depth = 1..6 */
    .thing.comment[data-nw-depth] {
      border-left: 1.5px solid color-mix(in srgb, var(--nw-line-color) 60%, transparent) !important;
      padding-left: 8px !important;
      margin-left: 0 !important;
    }
    .thing.comment[data-nw-depth="1"] { --nw-line-color: var(--nw-depth-1); }
    .thing.comment[data-nw-depth="2"] { --nw-line-color: var(--nw-depth-2); }
    .thing.comment[data-nw-depth="3"] { --nw-line-color: var(--nw-depth-3); }
    .thing.comment[data-nw-depth="4"] { --nw-line-color: var(--nw-depth-4); }
    .thing.comment[data-nw-depth="5"] { --nw-line-color: var(--nw-depth-5); }
    .thing.comment[data-nw-depth="6"] { --nw-line-color: var(--nw-depth-6); }

    /* Comment header */
    .comment .tagline .author { color: var(--nw-text) !important; font-weight: 600; }
    .comment .tagline .expand { color: var(--nw-text-faint) !important; }  /* the [–] */

    /* Colored dot before each commenter's name (JS 3j; same hash as favorites) */
    .nw-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin: 0 5px 0 2px;
      vertical-align: middle;
    }

    /* OP's username in the accent color (Reddit marks it with .submitter) */
    .tagline .author.submitter {
      background: none !important;
      color: var(--nw-accent) !important;
      font-weight: 700 !important;
    }
    /* Calm down mod/admin badges too */
    .tagline .author.moderator { background: none !important; color: var(--nw-green) !important; }
    .tagline .author.admin     { background: none !important; color: var(--nw-red) !important; }

    /* Collapsed comment: dimmed single line */
    .thing.comment.collapsed > .entry { opacity: 0.55; }

    /* Make it clear the comment is clickable */
    .nw-clickable .thing.comment > .entry { cursor: pointer; }
    .nw-clickable .thing.comment > .entry a,
    .nw-clickable .thing.comment > .entry .usertext-edit { cursor: auto; }
    .nw-clickable .thing.comment > .entry a { cursor: pointer; }

    /* "load more comments" */
    .morecomments a { color: var(--nw-accent) !important; font-size: 13px !important; }

    /* ---------- 2.10 Reply / edit boxes ------------------------------ */
    .usertext-edit textarea, input[type="text"], input[type="password"], input[type="url"] {
      background: var(--nw-input-bg) !important;
      color: var(--nw-text) !important;
      border: 1px solid var(--nw-separator) !important;
      border-radius: 8px !important;
    }
    .usertext-edit .bottom-area, .usertext-edit .help-toggle a { color: var(--nw-text-muted) !important; }
    .usertext-buttons button, .save-button button {
      background: var(--nw-accent) !important;
      color: #fff !important;
      border: none !important;
      border-radius: 8px !important;
      padding: 5px 12px !important;
    }
    .usertext-buttons button.cancel {
      background: var(--nw-fill) !important;
      color: var(--nw-text) !important;
    }

    /* ---------- 2.11 Pagination ("next ›") -------------------------- */
    /* Infinite scroll status line (3i) */
    .nw-loading {
      text-align: center;
      padding: 14px;
      color: var(--nw-text-muted);
      font: 13px var(--nw-font);
    }

    .nav-buttons .nextprev a {
      background: var(--nw-card) !important;
      color: var(--nw-accent) !important;
      border: 1px solid var(--nw-glass-edge) !important;
      box-shadow: var(--nw-shadow);
      border-radius: 10px !important;
      padding: 6px 14px !important;
      font-size: 14px !important;
    }

    /* ---------- 2.12 Split view (list left, post right) -------------- */
    /* JS (3e) adds .nw-split to <html> on wide windows on listing pages. */
    html.nw-split body > .content {
      max-width: var(--nw-list-width) !important;
      margin: 8px 0 40px 0 !important;
      padding: 0 10px !important;
    }
    html.nw-split #header {
      width: var(--nw-list-width) !important;
      overflow: hidden;
    }
    /* The column is too narrow for the user box to float over the tabs, so
       give it its own row above [Home / name / tabs]. */
    html.nw-split #header {
      display: flex !important;
      flex-direction: column;
    }
    html.nw-split #header-bottom-right {
      order: -1;
      position: static !important;
      align-self: stretch;
      border-radius: 0 !important;
      padding: 4px 10px !important;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-bottom: 1px solid var(--nw-separator) !important;
    }
    html.nw-split #header-bottom-left { max-width: none; width: 100%; }
    /* Narrow column: the user chip shows just the avatar (name in its tooltip) */
    html.nw-split .nw-user { gap: 3px; }
    html.nw-split .nw-user .nw-hbtn { width: 28px; height: 28px; }
    html.nw-split .nw-user-name,
    html.nw-split .nw-user-chip::after { display: none; }
    html.nw-split .nw-user-chip { padding: 0 2px !important; height: 28px; }
    html.nw-split #header .tabmenu li a { padding: 4px 9px !important; }

    .nw-pane {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      left: var(--nw-list-width);
      display: none;
      flex-direction: column;
      background: var(--nw-bg);
      border-left: 1px solid var(--nw-separator);
      z-index: 1000;
    }
    html.nw-split .nw-pane { display: flex; }
    .nw-pane-bar {
      flex: none;
      display: flex;
      align-items: center;
      gap: 12px;
      height: 40px;
      padding: 0 14px;
      background: var(--nw-card);
      -webkit-backdrop-filter: var(--nw-blur);
      backdrop-filter: var(--nw-blur);
      border-bottom: 1px solid var(--nw-separator);
      font: 600 13px var(--nw-font);
      color: var(--nw-text);
    }
    .nw-pane-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nw-pane-bar a, .nw-pane-bar button {
      color: var(--nw-accent) !important;
      background: none; border: none; cursor: pointer;
      font: inherit; padding: 0;
    }
    .nw-pane iframe { flex: 1; width: 100%; border: 0; background: var(--nw-bg); }
    .nw-pane-empty {
      margin: auto;
      color: var(--nw-text-faint);
      font: 15px var(--nw-font);
      text-align: center;
      padding: 20px;
    }
    .nw-pane.nw-has-post .nw-pane-empty { display: none; }
    .nw-pane:not(.nw-has-post) iframe,
    .nw-pane:not(.nw-has-post) .nw-pane-bar { display: none; }

    /* The post currently open on the right */
    .thing.link.nw-selected,
    .thing.link.nw-selected:hover {
      background: color-mix(in srgb, var(--nw-accent) 10%, var(--nw-card-hover)) !important;
    }
    html.nw-split .thing.link { cursor: pointer; }

    /* ---------- 2.13 Page shown inside the right pane --------------- */
    html.nw-in-pane #header { display: none !important; }
    html.nw-in-pane body > .content {
      max-width: var(--nw-pane-width) !important;
      margin: 12px auto 40px !important;
    }

    /* ---------- 2.14 Favorites sidebar (right edge) ------------------ */
    /* JS (3g) builds it and adds .nw-favs-on to <html> on wide windows. */
    .nw-favs {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: var(--nw-fav-width);
      display: none;
      flex-direction: column;
      background: var(--nw-sidebar-bg);
      -webkit-backdrop-filter: var(--nw-blur);
      backdrop-filter: var(--nw-blur);
      border-left: 1px solid var(--nw-glass-edge);
      box-shadow: -4px 0 20px rgba(15, 23, 42, 0.05);
      font-family: var(--nw-font);
      z-index: 1001;
    }
    html.nw-favs-on .nw-favs { display: flex; }

    /* Make room for it: the pane gets narrower, and the header's
       login/user box moves left so it isn't hidden underneath. */
    html.nw-favs-on .nw-pane { right: var(--nw-fav-width); }
    html.nw-favs-on:not(.nw-split) #header {
      margin-right: var(--nw-fav-width) !important;
    }

    .nw-favs-head {
      flex: none;
      padding: 14px 12px 8px;
    }
    .nw-favs-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--nw-text-muted);
      margin: 0 4px 8px;
    }
    .nw-favs-search {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 10px !important;
      font-size: 13px !important;
      background: var(--nw-fill) !important;
      border: none !important;
      border-radius: 9px !important;
      outline: none;
    }
    .nw-favs-list {
      flex: 1;
      overflow-y: auto;
      margin: 0;
      padding: 0 8px 16px;
      list-style: none;
    }
    .nw-favs-list a {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 8px;
      color: var(--nw-text) !important;
      font-size: 14px;
      text-decoration: none;
    }
    .nw-favs-list a:hover { background: var(--nw-fill); }
    .nw-favs-list a.nw-current {
      background: var(--nw-fill);
      color: var(--nw-accent) !important;
      font-weight: 600;
    }
    /* Colored letter circle (stand-in for the subreddit icon) */
    .nw-favs-avatar {
      flex: none;
      width: 24px; height: 24px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
    }
    .nw-favs-avatar.nw-has-img { background: transparent !important; }
    .nw-favs-avatar img {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      object-fit: cover;
      display: block;
    }
    .nw-favs-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

    /* Drag to reorder, × to remove (favorites only, not Home) */
    .nw-favs-list li { position: relative; }
    .nw-favs-list li[draggable="true"] a { cursor: grab; }
    .nw-favs-list li.nw-dragging { opacity: 0.4; }
    .nw-favs-remove {
      position: absolute;
      top: 50%; right: 6px;
      transform: translateY(-50%);
      width: 20px; height: 20px;
      display: none;
      place-items: center;
      border: none !important;
      border-radius: 50%;
      background: var(--nw-fill) !important;
      color: var(--nw-text-muted) !important;
      font: 600 14px/1 var(--nw-font) !important;
      cursor: pointer;
      padding: 0 !important;
    }
    .nw-favs-list li:hover .nw-favs-remove { display: grid; }
    .nw-favs-remove:hover { color: var(--nw-text) !important; }
    .nw-favs-list li.nw-dragging .nw-favs-remove { display: none; }

    /* ☆ / ★ button next to the subreddit name in the header */
    .nw-fav-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px !important;
      border-radius: 999px !important;
      background: var(--nw-fill) !important;
      border: none !important;
      color: var(--nw-text-muted) !important;
      font: 600 13px/18px var(--nw-font) !important;
      cursor: pointer;
    }
    .nw-fav-toggle:hover { color: var(--nw-text) !important; }
    .nw-fav-toggle.nw-on { color: var(--nw-accent) !important; }

    /* Small pill under the search box: "Copy list" */
    .nw-favs-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0 0;
    }
    .nw-favs-pill {
      appearance: none;
      padding: 3px 10px !important;
      border: none !important;
      border-radius: 999px !important;
      background: var(--nw-fill) !important;
      color: var(--nw-text-muted) !important;
      font: 600 12px/16px var(--nw-font) !important;
      cursor: pointer;
    }
    .nw-favs-pill:hover { color: var(--nw-text) !important; }

    /* ---------- 2.15 Read posts (JS 3l) ----------------------------- */
    /* The post open in the pane (.nw-selected) is never dimmed. */
    .thing.link.nw-read:not(.nw-selected) { opacity: 0.6; }
    .thing.link.nw-read:not(.nw-selected):hover { opacity: 1; }
    .thing.link.nw-read:not(.nw-selected) a.title { color: var(--nw-visited) !important; }
  `;

  // Inject immediately. At document-start <head> may not exist yet,
  // so fall back to <html>.
  const styleEl = document.createElement("style");
  styleEl.id = "nw-style";
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);
  // Tell reddit.user.css our styles are in, so it un-hides the page.
  document.documentElement.classList.add("nw-styled");

  /* ======================================================================
   * 3. PAGE BEHAVIOR
   * ==================================================================== */

  /* ---------- 3a. Remove subreddit custom stylesheets ---------------- */
  // Subreddits can ship their own CSS. We catch the <link> as soon as the
  // browser adds it (so it never renders), then stop watching.
  // UNSURE: old.reddit marks it with title="applied_subreddit_stylesheet".
  const SUB_CSS = 'link[title="applied_subreddit_stylesheet"], style[title="applied_subreddit_stylesheet"]';
  let headWatcher = null;
  if (CONFIG.disableSubredditStyles) {
    headWatcher = new MutationObserver(() => {
      document.querySelectorAll(SUB_CSS).forEach((el) => el.remove());
    });
    headWatcher.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- 3b. Metadata line under post titles -------------------- */
  // Builds:  r/subreddit · 3h ago · 120 comments
  // We *clone* Reddit's existing links, so they still work normally.
  function buildMeta(post) {
    if (post.classList.contains("nw-meta-ready")) return;
    const entry = post.querySelector(":scope > .entry");
    const tagline = entry && entry.querySelector(".tagline");
    if (!tagline) return;

    const parts = [];
    const sub = tagline.querySelector("a.subreddit");     // missing on a subreddit's own page
    const time = tagline.querySelector("time");
    const author = tagline.querySelector("a.author");
    const comments = entry.querySelector(".buttons a.comments");

    if (sub) parts.push(sub.cloneNode(true));
    if (time) {
      const t = time.cloneNode(true);
      // Drop "live-timestamp" so Reddit's timer doesn't rewrite it to "3 hours ago".
      t.classList.remove("live-timestamp");
      const short = shortTime(t.getAttribute("datetime"));
      if (short) t.textContent = short;   // full date stays in the hover tooltip
      parts.push(t);
    }
    if (CONFIG.showAuthorInMeta && author) parts.push(author.cloneNode(true));
    if (comments) {
      const c = comments.cloneNode(true);
      c.textContent = shortComments(comments.textContent);
      parts.push(c);
    }
    if (!parts.length) return;

    const meta = document.createElement("div");
    meta.className = "nw-meta";
    parts.forEach((node, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "nw-sep";
        sep.textContent = "·";
        meta.appendChild(sep);
      }
      node.removeAttribute("id"); // avoid duplicate IDs
      meta.appendChild(node);
    });

    // Style Reddit's own vote column (left side) as a pill. It stays where
    // Reddit put it, so voting works exactly as before.
    const votes = post.querySelector(":scope > .midcol");
    if (votes) votes.classList.add("nw-vote");

    // Reddit's expand button sits just before the tagline; move it into the
    // row so everything shares one line. It stays inside the same post, so
    // Reddit's expand code still finds it.
    const expando = tagline.previousElementSibling;
    if (expando && expando.classList.contains("expando-button")) meta.prepend(expando);

    // Save + "⋯" at the right end. Not on the post's own page, where
    // Reddit's full action row (edit, delete, nsfw…) stays visible.
    if (!document.body.classList.contains("comments-page")) addActions(post, meta);

    tagline.after(meta);
    post.classList.add("nw-meta-ready"); // CSS now hides the original tagline
  }

  /* Card actions. Every button clicks Reddit's own link for that action,
     looked up by its text at click time (Reddit sometimes swaps them). */
  const ACTION_TEXTS = {
    save: ["save", "unsave"],
    share: ["share"],
    hide: ["hide", "unhide"],
    report: ["report"],
    crosspost: ["crosspost"],
  };
  const MENU_ACTIONS = ["share", "hide", "report", "crosspost"];

  function findAction(post, kind) {
    const entry = post.querySelector(":scope > .entry");
    if (!entry) return null;
    for (const a of entry.querySelectorAll(".buttons a")) {
      if (ACTION_TEXTS[kind].includes(a.textContent.trim().toLowerCase())) return a;
    }
    return null;
  }

  function makeActionButton(kind, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `nw-act nw-act-${kind}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }

  // Filled bookmark when saved: Reddit flips the link text to "unsave".
  function syncSave(post) {
    const btn = post.querySelector(".nw-act-save");
    if (!btn) return;
    const orig = findAction(post, "save");
    const saved = orig
      ? orig.textContent.trim().toLowerCase() === "unsave"
      : post.classList.contains("saved");
    btn.setAttribute("aria-pressed", String(saved));
    btn.title = saved ? "Unsave" : "Save";
    btn.setAttribute("aria-label", btn.title);
  }

  // After a click, follow the post for a few seconds (covers Reddit
  // updating the text right away or after its request finishes).
  function watchSave(post) {
    const obs = new MutationObserver(() => syncSave(post));
    obs.observe(post, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    setTimeout(() => obs.disconnect(), 8000);
    syncSave(post);
  }

  function addActions(post, meta) {
    const hasSave = !!findAction(post, "save");
    const hasMenu = MENU_ACTIONS.some((k) => findAction(post, k));
    if (!hasSave && !hasMenu) return;

    const box = document.createElement("span");
    box.className = "nw-actions";

    if (hasSave) {
      const save = makeActionButton("save", "Save");
      save.addEventListener("click", () => {
        const orig = findAction(post, "save");
        if (!orig) return;
        orig.click();
        watchSave(post);
      });
      box.appendChild(save);
    }
    if (hasMenu) {
      const more = makeActionButton("more", "More");
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => {
        if (menuFor === more) closeMenu();
        else openMenu(more, post);
      });
      box.appendChild(more);
    }

    meta.appendChild(box);
    post.classList.add("nw-has-actions");   // CSS hides Reddit's row items
    syncSave(post);
  }

  // The "⋯" popover: one at a time, attached to <body>, fixed position.
  let menuEl = null;
  let menuFor = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuFor.setAttribute("aria-expanded", "false");
    menuEl = menuFor = null;
  }

  // Items: { kind, label, href } (a link) or { kind, label, onClick },
  // or { note } for a line of plain text. Empty entries are skipped.
  function showMenu(btn, items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "nw-menu";
    menu.setAttribute("role", "menu");
    for (const it of items) {
      if (!it) continue;
      if (it.note) {
        const note = document.createElement("div");
        note.className = "nw-menu-note";
        note.textContent = it.note;
        menu.appendChild(note);
        continue;
      }
      const item = document.createElement(it.href ? "a" : "button");
      if (it.href) item.href = it.href;
      else item.type = "button";
      item.className = `nw-menu-item nw-icon-${it.kind}`;
      item.setAttribute("role", "menuitem");
      item.textContent = it.label;
      item.addEventListener("click", () => {
        closeMenu();
        if (it.onClick) it.onClick();
      });
      menu.appendChild(item);
    }
    if (!menu.querySelector(".nw-menu-item")) return;

    document.body.appendChild(menu);
    menuEl = menu;
    menuFor = btn;
    btn.setAttribute("aria-expanded", "true");

    // Right-align under the button; flip above if there's no room below;
    // always keep 8px inside the window.
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector(".nw-menu-item").focus({ preventScroll: true });
  }

  // The card's "⋯" menu: Share / Hide / Report / Crosspost.
  function openMenu(btn, post) {
    showMenu(btn, MENU_ACTIONS.map((kind) => {
      const orig = findAction(post, kind);
      if (!orig) return null;
      const text = orig.textContent.trim();          // "hide" / "unhide"…
      return {
        kind,
        label: text.charAt(0).toUpperCase() + text.slice(1),
        onClick: () => orig.click(),
      };
    }));
  }

  // Close on outside click, Esc, scroll or resize.
  document.addEventListener("click", (e) => {
    if (menuEl && !menuEl.contains(e.target) && !menuFor.contains(e.target)) closeMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menuEl) return;
    const btn = menuFor;
    closeMenu();
    btn.focus({ preventScroll: true });
    e.stopPropagation();   // so Esc doesn't also close the split-view pane
  }, true);
  window.addEventListener("scroll", () => closeMenu(), true);
  window.addEventListener("resize", () => closeMenu());

  /* ---------- 3c. Comment depth colors ------------------------------- */
  // Top-level comments = depth 0 (no line). Replies get depth 1..6, cycling.
  function setDepth(comment) {
    if (comment.dataset.nwDepth !== undefined || comment.dataset.nwTop) return;
    let depth = 0;
    let el = comment.parentElement && comment.parentElement.closest(".thing.comment");
    while (el) {
      depth++;
      el = el.parentElement && el.parentElement.closest(".thing.comment");
    }
    if (depth === 0) {
      comment.dataset.nwTop = "1"; // mark as processed
    } else {
      comment.dataset.nwDepth = String(((depth - 1) % 6) + 1);
    }
  }

  /* ---------- 3d. Click to collapse comments ------------------------- */
  // Clicks on these never collapse (so links, votes, replies keep working).
  const IGNORE_CLICKS = [
    "a", "button", "input", "textarea", "select", "label",
    "img", "video", "summary", "[role='button']", "[onclick]",
    ".usertext-edit",          // the edit box for your own comment
    ".md-spoiler-text",        // spoilers reveal on click
    ".buttons",                // permalink / reply / save row
  ].join(",");

  // How long to wait for a possible second click (double-click = select a word).
  const DOUBLE_CLICK_MS = 150;
  let pendingCollapse = null;

  function onCommentClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const entry = e.target.closest(".entry");
    const comment = entry && entry.parentElement;
    if (!comment || !comment.matches(".thing.comment")) return;

    // Only check for links/buttons *inside* this comment's entry. Reddit puts
    // onclick="..." on the .thing wrapper itself, so checking the whole page
    // would wrongly ignore every click.
    const hit = e.target.closest(IGNORE_CLICKS);
    if (hit && entry.contains(hit)) return;

    // A second click within the window means a double-click (word selection):
    // cancel the pending collapse.
    if (e.detail > 1) {
      clearTimeout(pendingCollapse);
      pendingCollapse = null;
      return;
    }

    clearTimeout(pendingCollapse);
    pendingCollapse = setTimeout(() => {
      pendingCollapse = null;
      // Don't collapse if the user was selecting text.
      if (String(window.getSelection()).length > 0) return;
      // Use Reddit's own [–]/[+] toggle so its internal state stays correct.
      const toggle = entry.querySelector(".tagline a.expand");
      if (toggle) toggle.click();
    }, DOUBLE_CLICK_MS);
  }

  /* ---------- 3e. Split view (list on the left, post on the right) --- */
  // On listing pages (front page, subreddits), clicking a post loads its
  // comments page into a pane on the right instead of leaving the list.
  // The pane is an <iframe>: a full Reddit page, so voting and replying work.

  let pane = null;      // the right-hand pane element
  let paneFrame = null; // the <iframe> inside it
  let selectedPost = null;

  function isListingPage() {
    if (document.body.classList.contains("comments-page")) return false;
    return !!document.querySelector("#siteTable .thing.link");
  }

  // The comments-page URL of a post, on the *same* host we're on (old. or www.),
  // because the browser only lets us embed pages from the same site.
  function permalinkOf(post) {
    const raw = post.dataset.permalink ||
      (post.querySelector("a.comments") || {}).href;
    if (!raw) return null;
    const url = new URL(raw, location.origin);
    url.host = location.host;
    return url.href;
  }

  function buildPane() {
    if (pane) return; // may already exist (early pane, section 1)
    pane = document.createElement("div");
    pane.className = "nw-pane";
    pane.innerHTML = `
      <div class="nw-pane-bar">
        <span class="nw-pane-title"></span>
        <a class="nw-pane-open" target="_top" title="Open as full page">Open ↗</a>
        <button class="nw-pane-close" type="button" title="Close (Esc)">✕</button>
      </div>
      <iframe name="nw-pane-frame"></iframe>
      <div class="nw-pane-empty">Select a post</div>
    `;
    document.body.appendChild(pane);
    paneFrame = pane.querySelector("iframe");
    pane.querySelector(".nw-pane-close").addEventListener("click", closePane);
    paneFrame.addEventListener("load", onPaneLoad);
  }

  // `post` may be null (a post that isn't in the list, e.g. an old one
  // opened from Google); the title is then filled in once the pane loads.
  function openInPane(url, post) {
    if (selectedPost) selectedPost.classList.remove("nw-selected");
    selectedPost = post;
    if (post) {
      post.classList.add("nw-selected");
      markRead(post.dataset.fullname);
    }

    const title = post && post.querySelector("a.title");
    pane.querySelector(".nw-pane-title").textContent = title ? title.textContent : "";
    pane.querySelector(".nw-pane-open").href = url;
    pane.classList.add("nw-has-post");
    if (paneFrame.src !== url) paneFrame.src = url; // may already be loading
  }

  function closePane() {
    if (selectedPost) selectedPost.classList.remove("nw-selected");
    selectedPost = null;
    pane.classList.remove("nw-has-post");
    paneFrame.src = "about:blank";
  }

  // Runs each time the pane finishes loading a page.
  function onPaneLoad() {
    let doc;
    try {
      doc = paneFrame.contentDocument; // works because it's the same site
    } catch (err) {
      return;
    }
    if (!doc || !doc.documentElement) return;

    // If Reddit refused to be embedded, the frame stays blank: say so.
    if (pane.classList.contains("nw-has-post") && doc.location.href === "about:blank") {
      pane.querySelector(".nw-pane-title").textContent =
        "Reddit blocked loading this here. Use “Open ↗”.";
      return;
    }
    if (doc.location.href === "about:blank") return; // pane was just closed

    // The pane may have moved to another thread (a /comments/ link clicked
    // inside it), so refresh the bar and the list highlight on every load.
    const t = doc.querySelector(".thing.link a.title");
    pane.querySelector(".nw-pane-title").textContent = t ? t.textContent : doc.title;
    pane.querySelector(".nw-pane-open").href = doc.location.href;

    // Highlight the list post matching the loaded thread (none if it isn't in the list).
    const m = doc.location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    const match = m &&
      document.querySelector(`#siteTable .thing.link[data-fullname="t3_${m[1].toLowerCase()}"]`);
    if (selectedPost !== match) {
      if (selectedPost) selectedPost.classList.remove("nw-selected");
      selectedPost = match || null;
      if (selectedPost) selectedPost.classList.add("nw-selected");
    }

    // Backup in case the Userscripts app didn't run this script inside the
    // frame: at least copy our styles in. (Collapse/depth lines need the script.)
    doc.documentElement.classList.add("nw-in-pane", "nw-styled");
    if (!doc.getElementById("nw-style")) {
      const copy = doc.createElement("style");
      copy.id = "nw-style";
      copy.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(copy);
    }
  }

  // Clicks inside the list: open posts in the pane.
  function onListClick(e) {
    if (!document.documentElement.classList.contains("nw-split")) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const post = e.target.closest("#siteTable .thing.link");
    if (!post) return;

    const link = e.target.closest("a");
    if (link) {
      // Only the title, thumbnail and comment-count links open the pane.
      // Subreddit, author, share/save/hide etc. behave normally.
      if (!link.matches("a.title, a.thumbnail, a.comments")) return;
    } else if (e.target.closest(".midcol, .nw-vote, .buttons, .expando, .expando-button, button, input, textarea, form, .reportform")) {
      // Votes, the action row, and expanded media keep their normal behavior.
      return;
    }

    const url = permalinkOf(post);
    if (!url) return;
    e.preventDefault();
    openInPane(url, post);
  }

  function setupSplitView() {
    if (!CONFIG.splitView || IN_PANE || !isListingPage()) {
      document.documentElement.classList.remove("nw-split"); // early guess was wrong
      // We were redirected here for a post but can't show the split view
      // (private/NSFW-gated subreddit, empty list…): go back to the post.
      // The referrer is now Reddit, so this doesn't redirect again.
      const pending = takePendingPost();
      if (pending && !IN_PANE) location.replace(pending.url);
      return;
    }

    buildPane();
    document.addEventListener("click", onListClick);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pane.classList.contains("nw-has-post")) closePane();
    });

    // Turn split view on/off as the window is resized.
    const wide = window.matchMedia(`(min-width: ${CONFIG.splitMinWidth}px)`);
    const apply = () => document.documentElement.classList.toggle("nw-split", wide.matches);
    apply();
    wide.addEventListener("change", apply);

    openPendingPost();
  }

  // Pane URL for a pending post (same host, or the browser won't embed it).
  function paneUrlOf(pending) {
    const url = new URL(pending.url, location.origin);
    url.host = location.host;
    return url.href;
  }

  // A post we were redirected away from (section 1): open it / mark it in
  // the list. (Its loading may already have started early.)
  function takePendingPost() {
    try {
      const pending = JSON.parse(sessionStorage.getItem(OPEN_IN_PANE_KEY) || "null");
      sessionStorage.removeItem(OPEN_IN_PANE_KEY);
      return pending && pending.url ? pending : null;
    } catch (err) {
      return null;
    }
  }

  function openPendingPost() {
    const pending = takePendingPost();
    if (!pending) return;
    const post = document.querySelector(`#siteTable .thing.link[data-fullname="t3_${pending.id}"]`);
    openInPane(paneUrlOf(pending), post);
    if (post) post.scrollIntoView({ block: "center" });
  }

  /* ---------- 3f. Links clicked inside the right pane ---------------- */
  // Inside the pane, decide where each link should go:
  //   - other sites (imgur, news articles…) → new tab
  //   - other comment threads/permalinks    → stay in the pane
  //   - everything else on Reddit (subreddits, users…) → the main window
  function onPaneLinkClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    // Reddit's own buttons (reply, [–], load more…) use javascript:/# links.
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    const url = new URL(a.href);
    const sameSite = /(^|\.)reddit\.com$/.test(url.hostname);
    if (!sameSite) a.target = "_blank";
    else if (url.pathname.includes("/comments/")) a.target = "_self";
    else a.target = "_top";
  }

  /* ---------- 3g. Favorites sidebar --------------------------------- */
  // A fixed column on the right with your favorite subreddits. The search box
  // filters the list; pressing Enter opens the single match, or r/<typed>.
  // Drag rows to reorder, hover → × to remove, ☆ in the header to add.

  // Same name → same color every time (a simple hash turned into a hue).
  function colorFor(name) {
    let hash = 0;
    for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${hash} 55% 50%)`;
  }

  // Your favorites list, saved in this browser. CONFIG.favorites is the
  // master: we keep a fingerprint of it next to the saved list, and when
  // CONFIG.favorites changes (new version from GitHub) it replaces the
  // saved list. Otherwise the saved list (with your sidebar edits) is used.
  const FAV_KEY = "nw-favorites-v1";
  const FAV_FP_KEY = "nw-favorites-fp-v1";
  const FAV_FP = JSON.stringify(CONFIG.favorites);
  function loadFavorites() {
    try {
      const saved = JSON.parse(localStorage.getItem(FAV_KEY));
      const fp = localStorage.getItem(FAV_FP_KEY);
      const savedOk = Array.isArray(saved);
      if (fp !== FAV_FP) {
        localStorage.setItem(FAV_FP_KEY, FAV_FP);
        // No fingerprint yet but a saved list (first run of this version):
        // keep your current edits instead of wiping them.
        if (!(fp === null && savedOk)) {
          localStorage.setItem(FAV_KEY, FAV_FP);
          return CONFIG.favorites.slice();
        }
      }
      if (savedOk) return saved.filter((n) => typeof n === "string" && n);
    } catch (err) { /* storage blocked or bad data: use the default */ }
    return CONFIG.favorites.slice();
  }

  // Copy text to the clipboard; true if it worked.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Older API as a fallback (e.g. clipboard permission denied).
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { /* no luck */ }
      ta.remove();
      return ok;
    }
  }
  function saveFavorites(list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); }
    catch (err) { console.warn("[Reddit Tweaks] couldn't save favorites:", err); }
  }

  // The subreddit this page belongs to, e.g. "ClaudeAI" (as Reddit spells it),
  // or "" for the front page, r/all, multireddits, etc.
  function currentSubreddit() {
    const m = location.pathname.match(/^\/r\/([^/]+)/i);
    if (!m) return "";
    const fromUrl = decodeURIComponent(m[1]);
    if (/[+]/.test(fromUrl) || /^(all|popular|friends|mod)$/i.test(fromUrl)) return "";
    const title = document.querySelector("#header .pagename a");
    const shown = title ? title.textContent.trim() : "";
    return shown.toLowerCase() === fromUrl.toLowerCase() ? shown : fromUrl;
  }

  function setupFavorites() {
    if (IN_PANE) return;

    const currentName = currentSubreddit();
    const current = currentName.toLowerCase();
    const isFrontPage = /^\/(hot|new|rising|controversial|top|best)?\/?$/.test(location.pathname);
    let favorites = loadFavorites();
    const has = (name) => favorites.some((f) => f.toLowerCase() === name.toLowerCase());

    const box = document.createElement("nav");
    box.className = "nw-favs";
    box.innerHTML = `
      <div class="nw-favs-head">
        <div class="nw-favs-label">Favorites</div>
        <input class="nw-favs-search" type="search" placeholder="Search" autocomplete="off">
        <div class="nw-favs-tools">
          <button class="nw-favs-pill nw-favs-copy" type="button"
            title="Copy this list as a line to paste into CONFIG.favorites">Copy list</button>
        </div>
      </div>
      <ul class="nw-favs-list"></ul>
    `;
    const list = box.querySelector(".nw-favs-list");
    const search = box.querySelector(".nw-favs-search");

    // "Copy list": the list as a line to paste into CONFIG.favorites.
    const copyBtn = box.querySelector(".nw-favs-copy");
    let copyTimer = null;
    copyBtn.addEventListener("click", async () => {
      const line = `favorites: [${favorites.map((n) => JSON.stringify(n)).join(", ")}],`;
      copyBtn.textContent = (await copyText(line)) ? "Copied" : "Copy failed";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = "Copy list"; }, 1500);
    });

    function makeItem({ name, href, isCurrent, icon }, avatars) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = href;
      a.draggable = false;               // the <li> is what gets dragged
      a.dataset.name = name.toLowerCase();
      if (isCurrent) a.className = "nw-current";

      const avatar = document.createElement("span");
      avatar.className = "nw-favs-avatar";
      avatar.style.background = icon ? "var(--nw-accent)" : colorFor(name);
      avatar.textContent = icon || name[0].toUpperCase();

      const label = document.createElement("span");
      label.className = "nw-favs-name";
      label.textContent = name;

      a.append(avatar, label);
      li.appendChild(a);

      if (!icon) {
        avatars.set(name.toLowerCase(), avatar);
        li.draggable = true;
        li.dataset.fav = name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "nw-favs-remove";
        remove.title = `Remove r/${name} from favorites`;
        remove.textContent = "×";
        remove.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          setFavorites(favorites.filter((f) => f.toLowerCase() !== name.toLowerCase()));
        });
        li.appendChild(remove);
      }
      return li;
    }

    // Build the list. "Home" always comes first, then your favorites.
    // Links are relative, so they stay on old. or www.
    function render() {
      const avatars = new Map(); // subreddit (lowercase) → its avatar circle
      list.textContent = "";
      list.appendChild(makeItem({ name: "Home", href: "/", isCurrent: isFrontPage, icon: "⌂" }, avatars));
      favorites.forEach((name) => {
        list.appendChild(makeItem({
          name,
          href: `/r/${name}/`,
          isCurrent: name.toLowerCase() === current,
        }, avatars));
      });
      applyFilter();
      loadSubIcons(avatars);
      updateToggle();
    }

    function setFavorites(next) {
      favorites = next;
      saveFavorites(favorites);
      render();
    }

    // Filter as you type.
    function applyFilter() {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll("li").forEach((li) => {
        li.hidden = !li.firstChild.dataset.name.includes(q);
      });
    }
    const visibleLinks = () =>
      [...list.querySelectorAll("li")].filter((li) => !li.hidden).map((li) => li.firstChild);

    search.addEventListener("input", applyFilter);
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = search.value.trim().replace(/^\/?r\//i, "");
      if (!q) return;
      const matches = visibleLinks();
      location.href = matches.length === 1 ? matches[0].href : `/r/${encodeURIComponent(q)}/`;
    });

    // Drag to reorder. The row moves live while you drag; the new order is
    // saved when you let go.
    let dragged = null;
    list.addEventListener("dragstart", (e) => {
      const li = e.target.closest && e.target.closest("li[data-fav]");
      if (!li || search.value.trim()) { e.preventDefault(); return; } // no reordering a filtered list
      dragged = li;
      li.classList.add("nw-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", li.dataset.fav);
    });
    list.addEventListener("dragover", (e) => {
      if (!dragged) return;
      e.preventDefault();
      const over = e.target.closest && e.target.closest("li[data-fav]");
      if (!over || over === dragged) return;
      const box = over.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
      list.insertBefore(dragged, after ? over.nextSibling : over);
    });
    list.addEventListener("drop", (e) => { if (dragged) e.preventDefault(); });
    list.addEventListener("dragend", () => {
      if (!dragged) return;
      dragged.classList.remove("nw-dragging");
      dragged = null;
      const order = [...list.querySelectorAll("li[data-fav]")].map((li) => li.dataset.fav);
      if (order.join("\n") !== favorites.join("\n")) {
        favorites = order;
        saveFavorites(favorites);
      }
    });

    // ☆ / ★ next to the subreddit name: add or remove this subreddit.
    let toggle = null;
    const pagename = document.querySelector("#header .pagename");
    if (currentName && pagename) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nw-fav-toggle";
      toggle.addEventListener("click", () => {
        setFavorites(has(currentName)
          ? favorites.filter((f) => f.toLowerCase() !== current)
          : [...favorites, currentName]);
      });
      pagename.after(toggle);
    }
    function updateToggle() {
      if (!toggle) return;
      const on = has(currentName);
      toggle.classList.toggle("nw-on", on);
      toggle.title = on ? `Remove r/${currentName} from favorites` : `Add r/${currentName} to favorites`;
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-pressed", String(on));
    }

    // Changes made in another tab show up here too.
    window.addEventListener("storage", (e) => {
      if (e.key !== FAV_KEY) return;
      favorites = loadFavorites();
      render();
    });

    render();
    document.body.appendChild(box);

    // Only show it when the window is wide enough.
    const wide = window.matchMedia(`(min-width: ${CONFIG.favoritesMinWidth}px)`);
    const apply = () => document.documentElement.classList.toggle("nw-favs-on", wide.matches);
    apply();
    wide.addEventListener("change", apply);
  }

  // Real subreddit icons. Each subreddit's /about.json has its icon URL. We
  // remember them in this browser for a week, so it's 18 small requests at
  // most once a week. The letter circle stays if a subreddit has no icon.
  const ICON_CACHE_KEY = "nw-sub-icons-v1";
  const ICON_CACHE_DAYS = 7;

  function readIconCache() {
    try { return JSON.parse(localStorage.getItem(ICON_CACHE_KEY)) || {}; }
    catch (err) { return {}; }
  }
  function writeIconCache(cache) {
    // Merge with what's stored now: the header and the sidebar both write.
    try { localStorage.setItem(ICON_CACHE_KEY, JSON.stringify({ ...readIconCache(), ...cache })); }
    catch (err) { /* storage blocked: just refetch next time */ }
  }

  async function fetchSubIcon(name) {
    const res = await fetch(`/r/${encodeURIComponent(name)}/about.json`, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = ((await res.json()) || {}).data || {};
    // Reddit HTML-escapes "&" in these URLs.
    return (data.community_icon || data.icon_img || "").replace(/&amp;/g, "&");
  }

  function showSubIcon(avatar, url) {
    if (!url) return;
    const img = new Image();
    img.alt = "";
    img.onload = () => {            // swap the letter out only once it loads
      avatar.textContent = "";
      avatar.appendChild(img);
      avatar.classList.add("nw-has-img");
    };
    img.src = url;
  }

  async function loadSubIcons(avatars) {
    const cache = readIconCache();
    const now = Date.now();
    const maxAge = ICON_CACHE_DAYS * 24 * 60 * 60 * 1000;
    const missing = [];

    avatars.forEach((avatar, name) => {
      const hit = cache[name];
      if (hit && now - hit.t < maxAge) showSubIcon(avatar, hit.url);
      else missing.push(name);
    });
    if (!missing.length) return;

    await Promise.all(missing.map(async (name) => {
      try {
        const url = await fetchSubIcon(name);
        cache[name] = { url, t: now };   // "" is cached too (= no icon)
        showSubIcon(avatars.get(name), url);
      } catch (err) {
        console.warn(`[Reddit Tweaks] icon for r/${name} failed:`, err);
      }
    }));
    writeIconCache(cache);
  }

  /* ---------- 3h. Header: Home, subreddit name, user bar ------------ */
  // Reddit's home link is the logo, but subreddits with a custom banner
  // replace it with their own image (which we hide). So we add one Home
  // button that looks the same on every page, then hide Reddit's logo/banner.
  // The subreddit name gets "r/" and its icon; the user box becomes
  // [mail] [modmail] [avatar name ▾] with a menu (Profile, Saved, Preferences,
  // Log out). Logged out, Reddit's login links stay as they are.
  function setupHeader() {
    const headerLeft = document.querySelector("#header-bottom-left");
    if (!headerLeft || headerLeft.querySelector(".nw-home")) return;

    const home = document.createElement("a");
    home.className = "nw-home nw-hbtn";
    home.href = "/";
    home.title = "Home";
    home.setAttribute("aria-label", "Home");
    headerLeft.prepend(home);
    document.documentElement.classList.add("nw-home-ready");

    const sub = currentSubreddit();
    const pagename = headerLeft.querySelector(".pagename");
    if (sub && pagename) {
      pagename.classList.add("nw-sub-title");
      const avatar = document.createElement("span");
      avatar.className = "nw-favs-avatar";
      avatar.style.background = colorFor(sub);
      avatar.textContent = sub[0].toUpperCase();
      pagename.prepend(avatar);
      loadSubIcons(new Map([[sub.toLowerCase(), avatar]]));
    }

    setupUserBar(headerLeft);

    // Everything else Reddit keeps in this row (its logo link, spacers) is
    // already hidden or empty, but would still take a grid cell: drop it.
    const keep = ".nw-home, .pagename, .nw-fav-toggle, .tabmenu, .nw-user";
    [...headerLeft.children].forEach((el) => {
      if (!el.matches(keep)) el.classList.add("nw-gone");
    });
  }

  // Which of our icons a link in Reddit's user box gets (by id or address),
  // or null if we don't know it.
  function userIconKind(a) {
    const id = (a.id || "").toLowerCase();
    const href = a.getAttribute("href") || "";
    if (id === "mail" || /\/message\/(inbox|unread)/.test(href)) return "mail";
    if (id.includes("modmail") || /mod\.reddit\.com\/mail|\/message\/moderator/.test(href)) return "modmail";
    if (id.includes("notif") || /notifications/.test(href)) return "bell";
    if (id.includes("chat") || /\/chat\b|chat\.reddit/.test(href)) return "chat";
    return null;
  }

  function setupUserBar(headerLeft) {
    const right = document.querySelector("#header-bottom-right");
    const userLink = right && right.querySelector(".user a[href*='/user/']");
    if (!userLink) return;   // logged out

    const name = userLink.textContent.trim();
    const karma = right.querySelector(".userkarma");
    const karmaText = karma ? karma.textContent.trim() : "";
    const prefs = right.querySelector("a[href*='/prefs']");
    const logout = right.querySelector("form.logout");
    const count = right.querySelector("a.message-count");   // unread count, if any

    const bar = document.createElement("div");
    bar.className = "nw-user";

    right.querySelectorAll("a").forEach((a) => {
      if (a === userLink || a === prefs || a === count || a.closest(".user, form.logout")) return;
      const kind = userIconKind(a);
      if (!kind) {          // something we don't know: keep it, in a round button
        const wrap = document.createElement("span");
        wrap.className = "nw-hbtn nw-hbtn-raw";
        wrap.appendChild(a);
        bar.appendChild(wrap);
        return;
      }
      const btn = document.createElement("a");
      btn.className = `nw-hbtn nw-hbtn-${kind}`;
      btn.href = a.href;
      btn.title = a.title || a.textContent.trim() || kind;
      btn.setAttribute("aria-label", btn.title);
      // Reddit marks unread with e.g. "havemail" (vs "nohavemail").
      const unread = [...a.classList].some((c) => /^have|unread/.test(c));
      if (unread || (kind === "mail" && count)) {
        btn.classList.add("nw-unread");
        const badge = document.createElement("span");
        badge.className = "nw-badge";
        if (kind === "mail" && count) badge.textContent = count.textContent.trim();
        btn.appendChild(badge);
      }
      bar.appendChild(btn);
    });

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "nw-user-chip";
    chip.title = karmaText ? `u/${name} · ${karmaText} karma` : `u/${name}`;
    chip.setAttribute("aria-haspopup", "menu");
    chip.setAttribute("aria-expanded", "false");
    const avatar = document.createElement("span");
    avatar.className = "nw-user-avatar";
    avatar.style.background = colorFor(name);
    avatar.textContent = name[0].toUpperCase();
    const label = document.createElement("span");
    label.className = "nw-user-name";
    label.textContent = name;
    chip.append(avatar, label);

    const profile = userLink.href.replace(/\/?$/, "/");
    chip.addEventListener("click", () => {
      if (menuFor === chip) { closeMenu(); return; }
      showMenu(chip, [
        karmaText && { note: `${karmaText} karma` },
        { kind: "user", label: "Profile", href: profile },
        { kind: "save", label: "Saved", href: `${profile}saved/` },
        prefs && { kind: "prefs", label: "Preferences", href: prefs.href },
        // Reddit's hidden logout form (it carries the session token).
        logout && { kind: "logout", label: "Log out", onClick: () => HTMLFormElement.prototype.submit.call(logout) },
      ]);
    });
    bar.appendChild(chip);

    headerLeft.appendChild(bar);
    document.documentElement.classList.add("nw-user-ready");
  }

  /* ---------- 3i. Infinite scroll ----------------------------------- */
  // Old reddit pages end with "view more: next ›" (.nav-buttons). When that
  // comes near the screen, we download the next page in the background, take
  // its posts and add them to the current list. The "next" link is then
  // swapped for the new page's one, ready for the round after.
  // (Section 3k then styles the new posts like the rest.)

  let loadingMore = false;

  async function loadNextPage(table, observer) {
    const nav = table.querySelector(":scope > .nav-buttons");
    const next = nav && nav.querySelector(".next-button a");
    if (!next || loadingMore) return;
    loadingMore = true;

    // Show "Loading…" in place of the next button while we fetch.
    const status = document.createElement("div");
    status.className = "nw-loading";
    status.textContent = "Loading…";
    nav.hidden = true;
    nav.before(status);

    try {
      // Cookies are sent, so your own front page/subscriptions load.
      const res = await fetch(next.href, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const newTable = doc.querySelector("#siteTable");
      if (!newTable) throw new Error("no #siteTable in next page");

      // Skip ads and posts we already show (Reddit sometimes repeats them).
      const seen = new Set(
        [...table.querySelectorAll(":scope > .thing")].map((t) => t.dataset.fullname)
      );
      const frag = document.createDocumentFragment();
      newTable.querySelectorAll(":scope > .thing").forEach((thing) => {
        if (thing.matches(".promoted, .promotedlink")) return;
        if (seen.has(thing.dataset.fullname)) return;
        frag.appendChild(document.adoptNode(thing));
        const clear = document.createElement("div");
        clear.className = "clearleft";
        frag.appendChild(clear);
      });

      // Replace our old "next" with the new page's (or nothing on the last page).
      const newNav = newTable.querySelector(":scope > .nav-buttons");
      status.remove();
      nav.before(frag);
      if (newNav) {
        nav.replaceWith(document.adoptNode(newNav));
        observer.observe(table.querySelector(":scope > .nav-buttons"));
      } else {
        nav.remove();
      }
    } catch (err) {
      // Something went wrong: put the normal "next ›" button back.
      console.warn("[Reddit Tweaks] infinite scroll failed:", err);
      status.remove();
      nav.hidden = false;
    } finally {
      loadingMore = false;
    }
  }

  function setupInfiniteScroll() {
    if (!CONFIG.infiniteScroll || IN_PANE) return;
    const table = document.querySelector("#siteTable");
    const nav = table && table.querySelector(":scope > .nav-buttons");
    if (!nav || !nav.querySelector(".next-button a")) return;

    // Fire when "next" is within ~1.5 screens of being visible.
    const observer = new IntersectionObserver((items) => {
      items.forEach((item) => {
        if (!item.isIntersecting) return;
        observer.unobserve(item.target);
        loadNextPage(table, observer);
      });
    }, { rootMargin: "0px 0px 150% 0px" });
    observer.observe(nav);
  }

  /* ---------- 3j. Modern touches ----------------------------------- */

  // "2026-11-21T09:00:00Z" → "now", "5m", "3h", "2d", "4mo", "1y"
  function shortTime(iso) {
    const secs = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(secs)) return null;
    const mins = secs / 60, hours = mins / 60, days = hours / 24;
    if (mins < 1) return "now";
    if (hours < 1) return `${Math.floor(mins)}m`;
    if (days < 1) return `${Math.floor(hours)}h`;
    if (days < 30) return `${Math.floor(days)}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }

  // 950 → "950", 1234 → "1.2k", 45678 → "46k", 1234567 → "1.2M"
  function shortCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    if (n < 1e6) return `${Math.round(n / 1000)}k`;
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  }

  // "1234 comments" → "1.2k comments", "1 comment", "comment" → "0 comments"
  function shortComments(text) {
    const m = text.replace(/,/g, "").match(/\d+/);
    const n = m ? Number(m[0]) : 0;
    return `${shortCount(n)} ${n === 1 ? "comment" : "comments"}`;
  }

  // Turn share / save / hide / report / crosspost text links into icons.
  // Matched by their text; the text itself stays (hidden) for Reddit's code.
  const ICON_FOR_TEXT = {
    share: "share", save: "save", unsave: "save", hide: "hide", unhide: "hide",
    report: "report", crosspost: "crosspost",
  };
  function iconize(link) {
    if (link.dataset.nwIcon) return;
    const kind = ICON_FOR_TEXT[link.textContent.trim().toLowerCase()];
    link.dataset.nwIcon = kind || "none";   // mark as processed either way
    if (!kind) return;
    link.classList.add("nw-icon", `nw-icon-${kind}`);
    link.setAttribute("aria-label", link.textContent.trim());
  }
  // Tooltip = the link's current text (so it says "unsave" after saving).
  document.addEventListener("mouseover", (e) => {
    const a = e.target.closest && e.target.closest("a.nw-icon");
    if (a) a.title = a.textContent.trim();
  });

  // Small colored dot before a commenter's name.
  function addDot(author) {
    const prev = author.previousElementSibling;
    if (prev && prev.classList.contains("nw-dot")) return;
    const dot = document.createElement("span");
    dot.className = "nw-dot";
    dot.style.background = colorFor(author.textContent.trim());
    author.before(dot);
  }

  /* ---------- 3l. Read posts --------------------------------------- */
  // Opening a post (pane, title/thumbnail/comments link, or its own page)
  // remembers its fullname (t3_abc123) with the time. In listings those
  // posts get .nw-read (CSS 2.15 dims them).
  let readPosts = {};

  // Load from storage, dropping entries older than READ_DAYS.
  function loadRead() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(READ_KEY)); } catch (err) { /* blocked / bad data */ }
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
    const cutoff = Date.now() - READ_DAYS * 24 * 60 * 60 * 1000;
    let pruned = false;
    for (const [name, t] of Object.entries(data)) {
      if (!(t > cutoff)) { delete data[name]; pruned = true; }
    }
    readPosts = data;
    if (pruned) saveRead();
  }
  function saveRead() {
    try { localStorage.setItem(READ_KEY, JSON.stringify(readPosts)); }
    catch (err) { /* storage blocked: just not remembered */ }
  }

  function markRead(fullname) {
    if (!CONFIG.markRead || !fullname || !/^t3_[a-z0-9]+$/i.test(fullname)) return;
    loadRead();   // re-read first, so other tabs' entries aren't overwritten
    readPosts[fullname] = Date.now();
    saveRead();
    applyRead(document);
  }

  // Tag read posts in listings (not on a post's own page).
  function applyRead(root) {
    if (!CONFIG.markRead || document.body.classList.contains("comments-page")) return;
    root.querySelectorAll(".thing.link[data-fullname]").forEach((post) => {
      const read = Object.prototype.hasOwnProperty.call(readPosts, post.dataset.fullname);
      if (read !== post.classList.contains("nw-read")) post.classList.toggle("nw-read", read);
    });
  }

  function setupMarkRead() {
    if (!CONFIG.markRead) return;
    loadRead();

    // This page is a post (full page or in the pane): it's read now.
    const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (m) markRead(`t3_${m[1].toLowerCase()}`);

    // Clicking (or middle-clicking) a post's title, thumbnail or comments link.
    const onOpen = (e) => {
      if (e.type === "auxclick" && e.button !== 1) return;
      const a = e.target.closest && e.target.closest("a.title, a.thumbnail, a.comments");
      const post = a && a.closest(".thing.link[data-fullname]");
      if (post) markRead(post.dataset.fullname);
    };
    document.addEventListener("click", onOpen, true);
    document.addEventListener("auxclick", onOpen, true);

    // Posts opened in other tabs, or in the pane (its own page writes too).
    window.addEventListener("storage", (e) => {
      if (e.key !== READ_KEY) return;
      loadRead();
      applyRead(document);
    });
  }

  /* ---------- 3k. Process the page + watch for new content ----------- */
  function process(root) {
    applyRead(root);
    root.querySelectorAll(".thing.link").forEach(buildMeta);
    root.querySelectorAll(".thing.link .buttons a").forEach(iconize);
    root.querySelectorAll(".thing.comment").forEach(setDepth);
    root.querySelectorAll(".thing.comment > .entry .tagline a.author").forEach(addDot);
  }

  // www.reddit.com can serve either the old design (if "use old Reddit" is on
  // in your preferences) or the new one. Old reddit pages have #header and no
  // <shreddit-app>. UNSURE: these markers — send HTML if detection misfires.
  function isOldReddit() {
    if (location.hostname === "old.reddit.com") return true;
    return !!document.querySelector("#header") && !document.querySelector("shreddit-app");
  }

  function init() {
    // On the new design: undo everything and stop. (You may see a brief flash
    // of our styles first, because the CSS goes in before we can tell which
    // design it is.)
    if (!isOldReddit()) {
      styleEl.remove();
      earlyStyle.remove();
      if (headWatcher) headWatcher.disconnect();
      return;
    }

    if (redirecting) return; // leaving for the split view (section 1)

    // Head is fully parsed now; one last sweep for subreddit CSS, then stop watching.
    if (headWatcher) {
      document.querySelectorAll(SUB_CSS).forEach((el) => el.remove());
      headWatcher.disconnect();
    }

    setupMarkRead();
    process(document);

    if (CONFIG.clickToCollapse) {
      document.body.classList.add("nw-clickable");
      document.addEventListener("click", onCommentClick);
    }

    setupSplitView();
    setupFavorites();
    if (!IN_PANE) setupHeader();
    setupInfiniteScroll();
    if (IN_PANE) document.addEventListener("click", onPaneLinkClick);

    // New posts (infinite scroll from extensions) and "load more comments"
    // add nodes later. Batch the work once per animation frame.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        process(document);
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
