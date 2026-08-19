// ==UserScript==
// @name         zotdot
// @namespace    zotdot
// @version      0.8.6
// @description  Shows whether papers on article and search-result pages are already in your local Zotero library
// @author       Vincent Chamberland
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/vchamberland/zotdot/main/zotdot.user.js
// @downloadURL  https://raw.githubusercontent.com/vchamberland/zotdot/main/zotdot.user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * zotdot — "do I already have this paper?"
 *
 * Zotero 9's local API silently ignores the `q=` search parameter: querying a real
 * DOI, a nonsense string, or nothing at all returns the identical page of items.
 * Better BibTeX's JSON-RPC `item.search` returns [] for DOIs that provably exist.
 * There is no working search oracle to ask.
 *
 * So we don't ask. We mirror. The library is a versioned set exposed as an append
 * stream (`Last-Modified-Version` as cursor, `since=` for the delta), which makes
 * membership an O(1) local set lookup with zero network cost on the hot path.
 */

(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────── configuration

  const API = 'http://127.0.0.1:23119/api/users/0';
  const PAGE_SIZE = 500;          // local API honors this; the web API caps at 100
  const MAX_PAGES = 40;           // hard stop, ~20k top-level items
  const REFRESH_INTERVAL_MS = 120000;
  // Must NOT contain "Mozilla/" — see the note in gm.request().
  const UA = 'zotdot/0.8.6 (local Zotero client)';
  // Bumped to 4 when the index gained a creator-surname map; bumped to 5 when the
  // cache began recording the Zotero-Server-ID (see refreshIndex) so a cache built
  // against a different local database is discarded rather than served for the
  // wrong library. An older cache lacks these fields and is rebuilt, not trusted.
  const CACHE_VERSION = 5;

  const K_META = 'zotdot.meta';
  const K_DOI = 'zotdot.doi';
  const K_TITLE = 'zotdot.title';
  const K_CREATORS = 'zotdot.creators';

  const STATE = {
    HIT: 'hit',         // green  — DOI found in library
    MISS: 'miss',       // red    — DOI absent from a fresh index
    TITLE: 'title',     // amber  — no DOI match, but the title matches
    UNKNOWN: 'unknown', // grey   — Zotero unreachable, or index not built yet
  };

  // ────────────────────────────────────────────────────────── pure: normalizing

  // DOIs are case-insensitive by spec but stored inconsistently. Normalize both
  // sides of the comparison to the same shape or nothing will ever match.
  function normalizeDoi(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toLowerCase();
    s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
    s = s.replace(/^https?:\/\/doi\.org\//, '');
    s = s.replace(/^info:doi\//, '');
    s = s.replace(/^doi:\s*/, '');
    // Strip enclosing punctuation on both sides — DOIs are routinely printed
    // parenthesised or sentence-final.
    s = s.replace(/^[\s([{<"'‹«]+/, '');
    s = s.replace(/[\s.,;:)\]}>"'›»]+$/, '');
    return /^10\.\d{4,9}\/\S+$/.test(s) ? s : '';
  }

  // Result listings decorate titles with a format tag — Google Scholar emits
  // "[HTML] Closed-loop brain stimulation", "[PDF] ...", "[BOOK] ..." — and those
  // letters would otherwise become part of the key and never match the library.
  const LISTING_PREFIX = /^\s*\[(html|pdf|book|citation|b|c|h)\]\s*/i;

  function normalizeTitle(raw) {
    if (!raw) return '';
    return String(raw)
      .replace(LISTING_PREFIX, '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 90);
  }

  const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>&]+/g;

  function findDoisInText(text) {
    if (!text) return [];
    const out = [];
    for (const m of String(text).matchAll(DOI_RE)) {
      const d = normalizeDoi(m[0]);
      if (d) out.push(d);
    }
    return out;
  }

  // ───────────────────────────────────────────── environment shims (GM_* / GM.*)

  // Violentmonkey/Tampermonkey pass a response-ish object to onerror. Its fields
  // vary by manager and version, so pull anything present rather than assuming a
  // shape, and append the standing hint: on Chromium 151+ a loopback request can
  // be refused because the page's origin has no Local Network Access grant.
  function describeNetworkError(r) {
    const bits = [];
    if (r && typeof r === 'object') {
      for (const k of ['error', 'statusText', 'status', 'readyState', 'finalUrl']) {
        if (r[k] !== undefined && r[k] !== '' && r[k] !== null) bits.push(`${k}=${r[k]}`);
      }
    }
    const detail = bits.length ? bits.join(' ') : 'no detail from the userscript manager';
    return `network refused (${detail}) — target ${API}. `
      + 'Zotero drops any request carrying an Origin header or a "Mozilla/" User-Agent. '
      + 'If this persists, the userscript manager is adding an Origin header that cannot '
      + 'be suppressed — see README troubleshooting.';
  }

  const gm = {
    async get(key, fallback) {
      try {
        if (typeof GM !== 'undefined' && GM.getValue) return await GM.getValue(key, fallback);
        return GM_getValue(key, fallback);
      } catch (e) { return fallback; }
    },
    async set(key, value) {
      if (typeof GM !== 'undefined' && GM.setValue) return GM.setValue(key, value);
      return GM_setValue(key, value);
    },
    request(opts) {
      const fn = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
        ? GM.xmlHttpRequest.bind(GM)
        : GM_xmlhttpRequest;
      return new Promise((resolve, reject) => {
        fn({
          method: 'GET',
          timeout: 20000,
          // Zotero's local API is deliberately non-browser-only: it drops the
          // connection outright for any request carrying an `Origin` header, and
          // for any request whose User-Agent contains "Mozilla/". Measured against
          // Zotero 9.0.6 — `curl` with no Origin and a plain UA gets 200, the same
          // request with `-A "Mozilla/5.0"` gets an empty reply. This is an
          // anti-DNS-rebinding defence, not a bug, so the client must simply not
          // look like a browser. Violentmonkey can rewrite these restricted
          // headers because it holds webRequest/declarativeNetRequest permissions.
          anonymous: true,
          ...opts,
          headers: { 'User-Agent': UA, ...(opts.headers || {}) },
          onload: (r) => resolve(r),
          // A bare "network" says nothing about WHY. Surface whatever fields the
          // userscript manager hands back so the next failure names itself.
          onerror: (r) => reject(new Error(describeNetworkError(r))),
          ontimeout: () => reject(new Error('timeout — Zotero did not answer within 20s')),
        });
      });
    },
  };

  // ────────────────────────────────────────────────────────────── zotero client

  // Only ever reads, only ever from loopback. Never POST/PUT/DELETE, never a
  // non-loopback host — read-only membership badging is the whole contract.
  async function zoteroGet(path) {
    const res = await gm.request({ url: `${API}${path}` });
    if (res.status !== 200) throw new Error(`zotero ${res.status}`);
    const headers = {};
    for (const line of String(res.responseHeaders || '').trim().split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { headers, body: res.responseText };
  }

  // A 200 carrying an unexpected body must never be allowed to become the index.
  // Zotero answering with an error page, an empty string, or a bare object where
  // an array belongs would otherwise fold into a near-empty mirror and paint red
  // on the whole library. Throwing routes it to main's catch, which stays grey.
  function asItemArray(parsed) {
    if (!Array.isArray(parsed)) throw new Error('zotero: expected an item array');
    return parsed;
  }

  function asVersionsObject(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('zotero: expected a versions object');
    }
    return parsed;
  }

  const SKIP_TYPES = new Set(['attachment', 'note', 'annotation']);

  // Surnames, lowercased and stripped, for corroborating a title match against the
  // author line a result page prints. Zotero creators are either {lastName} or a
  // single {name} field for institutional authors.
  function creatorSurnames(creators) {
    if (!Array.isArray(creators)) return '';
    const out = [];
    for (const c of creators) {
      if (!c) continue;
      const raw = c.lastName || c.name || '';
      const norm = normalizeTitle(raw);
      if (!norm) continue;
      const last = norm.split(' ').filter(Boolean).pop();
      if (last && last.length >= 3 && !out.includes(last)) out.push(last);
      if (out.length >= 8) break; // long author lists add bytes, not certainty
    }
    return out.join(' ');
  }

  // True when any indexed surname appears as a whole word in the page's author
  // line. Scholar prints "C Lord, TS Brugha, G Dumas, ..." — initials collapse to
  // 1-2 char tokens, so only real surnames can match.
  function authorsCorroborate(surnames, pageAuthorText) {
    if (!surnames || !pageAuthorText) return false;
    const tokens = new Set(normalizeTitle(pageAuthorText).split(' ').filter(Boolean));
    return surnames.split(' ').some((sn) => sn.length >= 3 && tokens.has(sn));
  }

  function foldItems(items, doiMap, titleMap, creatorMap) {
    for (const it of items) {
      const d = it && it.data;
      if (!d || SKIP_TYPES.has(d.itemType)) continue;
      const doi = normalizeDoi(d.DOI);
      if (doi) doiMap[doi] = d.key;
      if (creatorMap) {
        const sn = creatorSurnames(d.creators);
        if (sn) creatorMap[d.key] = sn;
      }
      // EVERY item's title is indexed, including items that have a DOI. Google
      // Scholar result rows carry no DOI anywhere, so the title is the only
      // signal available there — restricting the title map to DOI-less items (as
      // v0.1 did) made every Scholar row for a paper you own render red.
      const t = normalizeTitle(d.title);
      if (t && !titleMap[t]) titleMap[t] = d.key;
    }
  }

  // Remove every DOI, title and creator entry that points at one of `keys`.
  // foldItems only ADDS, so an item whose DOI or title was corrected in Zotero
  // would otherwise keep its superseded value in the maps forever — a permanent
  // false green on any page still showing the old DOI/title. The delta refresh
  // evicts an edited item's stale entries before folding its fresh copy back in;
  // pruneDeleted uses the same shape for items that vanished entirely. Mutates the
  // maps in place. Pure over its inputs — no network, no GM storage.
  function evictItemKeys(keys, doiMap, titleMap, creatorMap) {
    const set = keys instanceof Set ? keys : new Set(keys);
    if (doiMap) for (const [k, v] of Object.entries(doiMap)) if (set.has(v)) delete doiMap[k];
    if (titleMap) for (const [k, v] of Object.entries(titleMap)) if (set.has(v)) delete titleMap[k];
    if (creatorMap) for (const k of Object.keys(creatorMap)) if (set.has(k)) delete creatorMap[k];
    return set;
  }

  async function buildIndex(onProgress) {
    const doiMap = Object.create(null);
    const titleMap = Object.create(null);
    const creatorMap = Object.create(null);
    let cursor = 0;
    let schema = '';
    let serverId = '';
    let pages = 0;
    // Only a short final page proves we reached the end of the library. Running
    // out of MAX_PAGES instead means the mirror is a prefix of the library, and a
    // prefix cannot answer "absent" — see indexIsUsable.
    let complete = false;

    for (let start = 0; pages < MAX_PAGES; start += PAGE_SIZE) {
      const { headers, body } = await zoteroGet(
        `/items/top?format=json&limit=${PAGE_SIZE}&start=${start}`
      );
      pages += 1;
      cursor = Math.max(cursor, parseInt(headers['last-modified-version'] || '0', 10) || 0);
      schema = headers['zotero-schema-version'] || schema;
      serverId = headers['zotero-server-id'] || serverId;

      const items = asItemArray(JSON.parse(body));
      foldItems(items, doiMap, titleMap, creatorMap);
      if (onProgress) onProgress(start + items.length, headers['total-results']);
      if (items.length < PAGE_SIZE) { complete = true; break; }
    }

    const meta = {
      cacheVersion: CACHE_VERSION,
      cursor,
      schema,
      serverId,
      builtAt: Date.now(),
      checkedAt: Date.now(),
      pages,
      complete,
      doiCount: Object.keys(doiMap).length,
      titleCount: Object.keys(titleMap).length,
      creatorCount: Object.keys(creatorMap).length,
    };
    await gm.set(K_DOI, doiMap);
    await gm.set(K_TITLE, titleMap);
    await gm.set(K_CREATORS, creatorMap);
    await gm.set(K_META, meta);
    return { meta, doiMap, titleMap, creatorMap };
  }

  // One cheap request. Returns {} when nothing changed, which is the common case.
  async function refreshIndex(meta) {
    const { headers, body } = await zoteroGet(
      `/items/top?since=${meta.cursor}&format=versions`
    );
    const serverVersion = parseInt(headers['last-modified-version'] || '0', 10) || meta.cursor;
    const changed = Object.keys(asVersionsObject(JSON.parse(body || '{}')));

    // A different local database (a switched account, or a restored backup) can
    // reuse the same version numbers, so `since=` would fold another library's
    // deltas into this cache. Zotero 10 tags each database with a stable
    // Zotero-Server-ID; when it changes, the cache belongs to a different library
    // and must be rebuilt from scratch rather than extended.
    const serverId = headers['zotero-server-id'] || '';
    if (serverId && meta.serverId && serverId !== meta.serverId) {
      return buildIndex();
    }

    if (headers['zotero-schema-version'] && headers['zotero-schema-version'] !== meta.schema) {
      return buildIndex(); // schema moved under us; the cache shape is no longer trustworthy
    }

    // The library version did not move, so nothing was added, edited, or deleted.
    // This is the common case and it costs no further requests.
    if (serverVersion === meta.cursor && !changed.length) {
      await gm.set(K_META, { ...meta, checkedAt: Date.now(), serverId: meta.serverId || serverId });
      return null; // caller keeps whatever it already loaded
    }

    const doiMap = await gm.get(K_DOI, null);
    const titleMap = (await gm.get(K_TITLE, null)) || Object.create(null);
    const creatorMap = (await gm.get(K_CREATORS, null)) || Object.create(null);
    // The delta folds changed items into the EXISTING maps. If the DOI map is
    // missing or empty, folding into a fresh object would persist a handful of
    // items as though they were the whole library — mass false red. Rebuild.
    if (!doiMap || !Object.keys(doiMap).length) return buildIndex();

    // Evict each edited item's OLD DOI/title before folding its fresh copy back
    // in — foldItems only adds, so a corrected DOI/title in Zotero would leave the
    // superseded value pointing at the item forever (a false green). New items
    // have no prior entry, so this is a no-op for them; pruneDeleted (below)
    // handles items that vanished entirely.
    evictItemKeys(changed, doiMap, titleMap, creatorMap);

    for (let i = 0; i < changed.length; i += 50) {
      const batch = changed.slice(i, i + 50).join(',');
      const { body: b } = await zoteroGet(`/items?itemKey=${batch}&format=json`);
      foldItems(asItemArray(JSON.parse(b)), doiMap, titleMap, creatorMap);
    }

    // A trashed item vanishes from `/items/top?since=`, so `changed` can be empty
    // while the library version moved — a deletion is exactly that shape. Pruning
    // must therefore run whenever the version moved at all, not only when items
    // came back, and always against the PRE-refresh cursor: once the cursor
    // advances past a deletion, `/deleted?since=` can never report it again and
    // the stale entry is a permanent false green.
    const pruneResult = await pruneDeleted(meta.cursor, doiMap, titleMap, creatorMap);

    // Hold the cursor back when the deletion window could not be read, so the
    // next refresh retries the same window instead of skipping past it forever.
    // A Zotero with no /deleted endpoint is a different case: retrying gains
    // nothing there, so the cursor advances and deletions surface on rebuild.
    const nextCursor = pruneResult === 'failed' ? meta.cursor : serverVersion;
    const next = { ...meta, checkedAt: Date.now(), cursor: nextCursor, serverId: meta.serverId || serverId };
    next.doiCount = Object.keys(doiMap).length;
    next.titleCount = Object.keys(titleMap).length;
    next.creatorCount = Object.keys(creatorMap).length;
    await gm.set(K_DOI, doiMap);
    await gm.set(K_TITLE, titleMap);
    await gm.set(K_CREATORS, creatorMap);
    await gm.set(K_META, next);
    return { meta: next, doiMap, titleMap, creatorMap };
  }

  // Deletions do not show up in `since=`; Zotero exposes them separately.
  // Returns 'pruned' when the window was read, 'unsupported' when this Zotero has
  // no /deleted endpoint at all, and 'failed' when the request itself broke. The
  // caller uses that to decide whether the cursor may advance past this window:
  // advancing past an unread deletion makes it permanently invisible.
  async function pruneDeleted(since, doiMap, titleMap, creatorMap) {
    let body;
    try {
      ({ body } = await zoteroGet(`/deleted?since=${since}`));
    } catch (e) {
      return /zotero (404|501)/.test(e.message) ? 'unsupported' : 'failed';
    }
    let gone;
    try {
      gone = new Set((JSON.parse(body || '{}').items) || []);
    } catch (e) {
      return 'failed'; // unparseable body — treat the window as unread
    }
    for (const [k, v] of Object.entries(doiMap)) if (gone.has(v)) delete doiMap[k];
    for (const [k, v] of Object.entries(titleMap)) if (gone.has(v)) delete titleMap[k];
    if (creatorMap) for (const k of Object.keys(creatorMap)) if (gone.has(k)) delete creatorMap[k];
    return 'pruned';
  }

  // ────────────────────────────────────────────────────────── page: extraction

  // Order is empirical (surveyed Nature, PLOS, Frontiers, bioRxiv, eNeuro, arXiv):
  // `citation_doi` is present on every verified site except arXiv. `dc.identifier`
  // is equally widespread but its value is bare on PLOS/eNeuro/bioRxiv and
  // `doi:`-prefixed on Nature/Frontiers — normalizeDoi absorbs both.
  const META_DOI_KEYS = [
    'citation_doi',
    'bepress_citation_doi',
    'dc.identifier',
    'dc.identifier.doi',
    'prism.doi',
  ];

  // IEEE Xplore is an Angular app whose article DOI never appears as a <meta> tag
  // or a doi.org link — it lives only inside an inline `xplGlobal.document.metadata`
  // script object, which IS server-rendered and present from the first paint. Read
  // it there. Gated to the IEEE host so no other page pays for the script scan.
  function ieeeDoi(root) {
    if (!/(^|\.)ieeexplore\.ieee\.org$/i.test(location.hostname)) return '';
    for (const s of root.querySelectorAll('script:not([src])')) {
      const t = s.textContent;
      if (!t || t.indexOf('xplGlobal') === -1) continue;
      const m = t.match(/"doi"\s*:\s*"(10\.\d{4,9}\/[^"\\]+)"/);
      if (m) { const d = normalizeDoi(m[1]); if (d) return d; }
    }
    return '';
  }

  function metaDoi(root) {
    for (const key of META_DOI_KEYS) {
      const nodes = root.querySelectorAll(
        `meta[name="${key}" i], meta[property="${key}" i]`
      );
      for (const n of nodes) {
        const d = normalizeDoi(n.getAttribute('content'));
        if (d) return d;
      }
    }
    // arXiv ships no citation_doi at all — only its own minted DOI, and only as
    // a link id. Fall back to that, then to constructing it from the arXiv id.
    const arxivLink = root.querySelector('a#arxiv-doi-link');
    if (arxivLink) {
      const d = normalizeDoi(arxivLink.getAttribute('href')) || normalizeDoi(arxivLink.textContent);
      if (d) return d;
    }
    const arxivId = root.querySelector('meta[name="citation_arxiv_id" i]');
    if (arxivId) {
      const id = (arxivId.getAttribute('content') || '').trim();
      if (id) {
        const d = normalizeDoi(`10.48550/arxiv.${id}`);
        if (d) return d;
      }
    }
    // Nature and Frontiers repeat the DOI inside JSON-LD as a redundant source.
    for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
      const hits = findDoisInText(s.textContent);
      if (hits.length) return hits[0];
    }
    // Site-specific last resort for apps that keep the DOI out of the DOM entirely.
    const ieee = ieeeDoi(root);
    if (ieee) return ieee;
    return '';
  }

  function metaTitle(root) {
    const sel = 'meta[name="citation_title" i], meta[name="dc.title" i], meta[property="og:title"]';
    for (const n of root.querySelectorAll(sel)) {
      const t = (n.getAttribute('content') || '').trim();
      if (t) return t;
    }
    const h1 = root.querySelector('h1');
    return h1 ? h1.textContent.trim() : (document.title || '');
  }

  // A DOI sitting inside a reference list belongs to a cited work, not to the
  // article being displayed. Badging it would answer a question nobody asked.
  // The article's own title element. Publisher-specific classes come first,
  // because a bare `h1` on some sites is the journal name or a site banner.
  const ARTICLE_TITLE_SELECTORS = [
    'h1.c-article-title',            // BMC / Springer Nature
    'h1[data-test="article-title"]', // BMC
    'h1.citation__title',            // ACS
    'h1.article-title',              // HighWire (eNeuro, bioRxiv)
    'h1#screen-reader-main-title',   // ScienceDirect
    'h1.title-text',                 // Wiley
    'h1.document-title',             // IEEE Xplore (rendered client-side)
    'h1.title',                      // arXiv — its first bare h1 is the subject category, not the paper
    'h1',
  ];

  function articleTitleElement() {
    for (const sel of ARTICLE_TITLE_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && (el.textContent || '').trim()) return el;
      } catch (e) { /* malformed selector — skip */ }
    }
    return null;
  }

  // Verified necessary: Nature, eNeuro and bioRxiv article pages all carry many
  // doi.org links in their reference lists, so an unscoped `a[href*="doi.org"]`
  // would badge cited works instead of the article being read.
  const REFERENCE_ZONES = [
    '.references', '#references', '#ref-list', '.ref-list', 'ol.references',
    '.citation-list', '#bibliography', '.bibliography', 'section[id*="bibl" i]',
    '.c-article-references', '#Bib1', '[id^="Bib"]', '.article-references',
    '.ref-cit-blk', '.cit-pub-id-doi', '#reference-list', '.reference-list',
    '[data-title="References"]', 'section[aria-labelledby*="ref" i]',
  ].join(',');

  function inReferenceZone(node) {
    return !!(node.closest && node.closest(REFERENCE_ZONES));
  }

  // Visible DOI anchors, in preference order, so the dot lands where Vincent's
  // eye already is rather than somewhere structurally convenient.
  function findDoiAnchors(root) {
    const found = [];
    const seen = new Set();
    // The same DOI printed twice on one page is still one identity, so dedupe by
    // value — two dots for one DOI is two answers to one question.
    const seenDoi = new Set();

    for (const a of root.querySelectorAll('a[href*="doi.org/"], a[href^="doi:"]')) {
      if (inReferenceZone(a)) continue;
      const doi = normalizeDoi(a.getAttribute('href')) || normalizeDoi(a.textContent);
      if (!doi || seen.has(a)) continue;
      seen.add(a);
      seenDoi.add(doi);
      found.push({ doi, node: a, source: 'link' });
    }

    // Do NOT stop here when links were found. Nature prints the article's own DOI
    // as plain text while linking dozens of *cited* DOIs, so a page can legitimately
    // carry both link anchors and a text-only DOI that matters more. Verified by
    // rendering: early-returning here left the Nature-shaped case unbadged.

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.length > 400) return NodeFilter.FILTER_REJECT;
        if (!/10\.\d{4,9}\//.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || inReferenceZone(p)) return NodeFilter.FILTER_REJECT;
        if (/^(script|style|noscript|textarea)$/i.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && found.length < 8) {
      const dois = findDoisInText(n.nodeValue);
      if (!dois.length || seenDoi.has(dois[0])) continue;
      seenDoi.add(dois[0]);
      found.push({ doi: dois[0], node: n.parentElement, source: 'text' });
    }
    return found;
  }

  // ───────────────────────────────────────────────────────── page: site adapters

  // Multi-result pages are where this is most useful and where a per-page
  // single-DOI assumption falls apart hardest.
  const ROW_ADAPTERS = [
    // Scholar profile ("citations") pages list publications in a table, not in
    // the .gs_r result blocks, so the search adapter finds zero rows there.
    // NOTE: these two selectors are from prior knowledge, NOT verified against a
    // live page this session — scholar.google.com served a captcha to every
    // non-browser fetch. If profile pages stay bare, these are the two strings to
    // correct, and nothing else needs to change.
    { host: /scholar\.google\./, rows: '#gsc_a_b .gsc_a_tr', title: '.gsc_a_at', authors: '.gs_gray', distinctive: true },
    { host: /scholar\.google\./, rows: '#gs_res_ccl_mid .gs_r.gs_or', title: '.gs_rt', authors: '.gs_a', distinctive: true },
    { host: /pubmed\.ncbi\.nlm\.nih\.gov/, rows: 'article.full-docsum', title: '.docsum-title', authors: '.docsum-authors', distinctive: true },
    { host: /(bio|med)rxiv\.org/, rows: '.highwire-article-citation', title: '.highwire-cite-title', authors: '.highwire-citation-authors', distinctive: true },
    { host: /europepmc\.org/, rows: '.resultList > li', title: '.title', authors: '.authors' },
    { host: /semanticscholar\.org/, rows: '[data-test-id="search-result"]', title: '[data-test-id="title-link"]', authors: '[data-test-id="author-list"]' },
    { host: /sciencedirect\.com\/search/, rows: '.ResultItem', title: '.result-list-title-link', authors: '.Authors' },
  ];

  // `distinctive: true` marks a rows-selector specific enough to identify the
  // platform on its own. Those adapters activate structurally, which is strictly
  // more robust than hostname matching: it survives regional Scholar domains,
  // library proxies, and HighWire-family journals we never enumerated. Generic
  // selectors (`.ResultItem`, `.resultList > li`) stay host-gated, because
  // structural activation on them would false-positive on unrelated sites.
  function rowsPresent(a) {
    try { return !!document.querySelector(a.rows); } catch (e) { return false; }
  }

  function activeAdapter() {
    const here = location.hostname + location.pathname;
    const onThisHost = ROW_ADAPTERS.filter((a) => a.host.test(here));
    // One host can serve several layouts — Scholar has both a search-results page
    // and a profile page. Matching the hostname is not enough; take the adapter
    // whose rows actually exist in this document.
    for (const a of onThisHost) if (rowsPresent(a)) return a;
    for (const a of ROW_ADAPTERS) if (a.distinctive && rowsPresent(a)) return a;
    // A known listing host with no rows yet (still loading, or an empty search) is
    // still NOT an article page — return the host adapter so the single-paper
    // branch does not start badging navigation headings.
    return onThisHost[0] || null;
  }

  // ──────────────────────────────────────────────────────────── page: rendering

  // Glossy indicator-lamp styling: a specular highlight up and left, a shading
  // wash down and right, and a coloured halo. Two things keep it usable rather
  // than merely decorative — the halo is sized in em so it scales with the host
  // page's type, and `unknown` is deliberately an UNLIT lamp (dim, no halo), so
  // "I could not check" never looks like a confident answer.
  const CSS = `
  .zotdot {
    display: inline-block; width: .72em; height: .72em;
    min-width: 10px; min-height: 10px;
    border-radius: 50%; margin: 0 .4em; padding: 0;
    vertical-align: baseline; border: 0; line-height: 1;
    cursor: default; flex: none;
    background-repeat: no-repeat;
    background-image:
      radial-gradient(circle at 34% 27%, rgba(255,255,255,.92) 0%, rgba(255,255,255,.38) 26%, rgba(255,255,255,0) 56%),
      radial-gradient(circle at 52% 118%, rgba(0,0,0,.42) 0%, rgba(0,0,0,0) 62%);
  }
  .zotdot[data-zotdot="hit"] {
    background-color: #5ec927;
    box-shadow: 0 0 .42em .07em rgba(126,224,33,.72), inset 0 0 .2em rgba(255,255,255,.4), 0 0 0 1px rgba(0,0,0,.16);
  }
  .zotdot[data-zotdot="miss"] {
    background-color: #ef3124;
    box-shadow: 0 0 .42em .07em rgba(239,49,36,.68), inset 0 0 .2em rgba(255,255,255,.35), 0 0 0 1px rgba(0,0,0,.16);
  }
  .zotdot[data-zotdot="title"] {
    background-color: #f97116;
    box-shadow: 0 0 .42em .07em rgba(249,113,22,.7), inset 0 0 .2em rgba(255,255,255,.38), 0 0 0 1px rgba(0,0,0,.16);
  }
  .zotdot[data-zotdot="unknown"] {
    background-color: #6b7280;
    background-image:
      radial-gradient(circle at 34% 27%, rgba(255,255,255,.45) 0%, rgba(255,255,255,.12) 30%, rgba(255,255,255,0) 58%),
      radial-gradient(circle at 52% 118%, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 62%);
    box-shadow: inset 0 0 .2em rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.22);
    opacity: .72;
  }
  .zotdot[data-zotdot="hit"], .zotdot[data-zotdot="title"] { cursor: pointer; }
  `;

  function injectCss() {
    try {
      if (typeof GM_addStyle === 'function') return GM_addStyle(CSS);
    } catch (e) { /* fall through */ }
    const s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function ageString(ts) {
    if (!ts) return 'never';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  function tooltip(state, info) {
    const age = `index built ${ageString(info.builtAt)}, checked ${ageString(info.checkedAt)}`;
    switch (state) {
      case STATE.HIT: {
        if (info.via === 'title+author') {
          return `In Zotero — title match confirmed by an author on this page\n${age}\nClick to open in Zotero`;
        }
        if (info.via === 'title') {
          return `In Zotero — exact title match (no DOI on this page)\n${age}\nClick to open in Zotero`;
        }
        return `In Zotero — DOI match (${info.doi})\n${age}\nClick to open in Zotero`;
      }
      case STATE.TITLE: return `Probably in Zotero — title match, but the title is short enough to collide\n${age}\nClick to open in Zotero`;
      case STATE.MISS: return `Not in Zotero (${info.doi || 'no DOI found'})\n${age}`;
      default: return `Unknown — ${info.reason || 'Zotero not reachable'}\n${age}`;
    }
  }

  // Idempotency is keyed on (anchor node, DOI), not on the node alone. A single
  // element can legitimately carry several distinct DOIs — a text anchor is the
  // shared parentElement of its text nodes — and a node-only guard would repaint
  // the first DOI's dot with the second DOI's verdict.
  const painted = new WeakMap(); // node -> Map<doiKey, dotElement>

  // `idKey` MUST come from stable page data (the anchor's DOI, or the row's
  // normalized title) and never from the verdict — the verdict's DOI is empty on
  // the pre-index grey pass and populated afterwards, which would key the same
  // anchor twice and stack two dots on it.
  // `inside: true` appends the dot as the last child of `node` instead of
  // inserting it after `node`. Required whenever the anchor is an element whose
  // last child we would otherwise target: passing `el.lastChild` is a moving
  // target, because after the first insertion the last child IS the dot, so the
  // next scan keys on a different node and appends a second one. Anchor on the
  // stable element and grow inside it.
  function placeDot(node, state, info, idKey, inside) {
    if (!node) return null;
    if (!inside && !node.parentNode) return null;
    const key = idKey || info.doi || '∅';

    let byDoi = painted.get(node);
    if (!byDoi) { byDoi = new Map(); painted.set(node, byDoi); }

    const existing = byDoi.get(key);
    if (existing && existing.isConnected) {
      paintDot(existing, state, info); // a rescan may sharpen the verdict
      return existing;
    }

    const dot = document.createElement('span');
    dot.className = 'zotdot';
    dot.dataset.zotdotFor = key;
    paintDot(dot, state, info);
    if (inside) node.appendChild(dot);
    else node.parentNode.insertBefore(dot, node.nextSibling);
    byDoi.set(key, dot);
    return dot;
  }

  function paintDot(dot, state, info) {
    dot.dataset.zotdot = state;
    dot.title = tooltip(state, info);
    dot.setAttribute('aria-label', tooltip(state, info).split('\n')[0]);
    dot.onclick = (info.key && (state === STATE.HIT || state === STATE.TITLE))
      ? () => { location.href = `zotero://select/library/items/${info.key}`; }
      : null;
  }

  // ────────────────────────────────────────────────────────────── decide + paint

  // The maps are created with Object.create(null), but they round-trip through GM
  // storage as JSON and come back with Object.prototype attached. normalizeTitle
  // emits [a-z0-9 ] only, so a paper titled "Constructor" normalizes to exactly
  // `constructor` — a bare `map[key]` would hit the prototype and report a match
  // whose "key" is a function. Own-property only.
  function lookupKey(map, key) {
    if (!map || !key) return '';
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
  }

  // Guards the title-match-as-green rule above. A title has to be long enough and
  // wordy enough that two unrelated papers are unlikely to share it exactly.
  const TITLE_GREEN_MIN_CHARS = 25;
  const TITLE_GREEN_MIN_WORDS = 4;

  function titleIsDistinctive(t) {
    if (!t || t.length < TITLE_GREEN_MIN_CHARS) return false;
    return t.split(' ').filter(Boolean).length >= TITLE_GREEN_MIN_WORDS;
  }

  function decide(doi, title, index, pageAuthors) {
    if (!index) return { state: STATE.UNKNOWN, reason: 'index not built yet' };
    // An index that cannot answer "absent" must never say "absent". A truncated or
    // empty mirror still answers "present" correctly, so hits are kept.
    const doiKey = lookupKey(index.doiMap, doi);
    if (doi && doiKey) return { state: STATE.HIT, key: doiKey, doi };
    const t = normalizeTitle(title);
    const titleKey = lookupKey(index.titleMap, t);
    if (t && titleKey) {
      // An exact match on a long, distinctive title is strong evidence — strong
      // enough for green. Google Scholar carries no DOI anywhere, so holding every
      // Scholar row at amber made amber the only colour that page could ever show,
      // which is no signal at all. Short or generic titles ("Editorial",
      // "Introduction", "Corrigendum") collide across papers and stay amber.
      if (titleIsDistinctive(t)) return { state: STATE.HIT, key: titleKey, doi, via: 'title' };
      // A short title alone collides, but a short title PLUS an author printed on
      // the page is a different claim entirely. "Autism spectrum disorder" is
      // shared by many works; "Autism spectrum disorder" by an author list
      // containing Lord and Dumas is the one in the library.
      if (authorsCorroborate(lookupKey(index.creatorMap, titleKey), pageAuthors)) {
        return { state: STATE.HIT, key: titleKey, doi, via: 'title+author' };
      }
      return { state: STATE.TITLE, key: titleKey, doi, via: 'title' };
    }
    if (index.unusable) {
      return { state: STATE.UNKNOWN, reason: index.unusableReason || 'index incomplete', doi };
    }
    if (!doi && !t) return { state: STATE.UNKNOWN, reason: 'no DOI or title on page' };
    // Red is only reachable from a complete index we actually have. Every other
    // path is grey.
    return { state: STATE.MISS, doi };
  }

  function scan(index, meta) {
    const info0 = { builtAt: meta.builtAt, checkedAt: meta.checkedAt };
    const pageDoi = metaDoi(document) || '';

    // An article page that happens to embed a results-shaped list ("related
    // articles") is still an article page. Its own citation_doi outranks any
    // structural row match, so the dot lands on the paper actually being read.
    const adapter = pageDoi ? null : activeAdapter();
    const rows = adapter ? Array.from(document.querySelectorAll(adapter.rows)) : [];

    if (rows.length) {
      for (const row of rows) {
        const titleBlock = row.querySelector(adapter.title) || row.querySelector('a');
        if (!titleBlock) continue;
        // Anchor to the inner link, not the block-level heading — inserting after
        // an <h3> puts the dot on its own line instead of beside the title.
        const titleEl = titleBlock.querySelector('a') || titleBlock;
        const anchors = findDoiAnchors(row);
        const doi = anchors.length ? anchors[0].doi : '';
        const titleText = titleEl.textContent || '';
        // The author line printed under the row corroborates a short title match
        // that would otherwise be too generic to call green.
        const authorEl = adapter.authors ? row.querySelector(adapter.authors) : null;
        const authorText = authorEl ? authorEl.textContent || '' : '';
        const verdict = decide(doi, titleText, index, authorText);
        const target = anchors.length ? anchors[0].node : titleEl;
        placeDot(target, verdict.state, { ...info0, ...verdict },
          doi || normalizeTitle(titleText) || 'row');
      }
      return rows.length;
    }

    // Single-paper page.
    const title = metaTitle(document);
    const anchors = findDoiAnchors(document.body || document);

    // Badge the article title whenever the page has a paper identity — not merely
    // as a fallback when no DOI is visible. On BMC/Springer the only visible DOI
    // sits in a citation block at the very bottom of the article, where a dot
    // answers the question long after you have scrolled past asking it. The title
    // is always at the top, so that is where the answer belongs.
    const hasIdentity = !!pageDoi || !!document.querySelector('meta[name="citation_title" i]');
    let painted = 0;
    if (hasIdentity) {
      const titleEl = articleTitleElement();
      if (titleEl) {
        const v = decide(pageDoi, title, index);
        placeDot(titleEl, v.state, { ...info0, ...v },
          pageDoi || normalizeTitle(title) || 'article-title', true);
        painted += 1;
      }
    }


    // Only badge a visible DOI when the title could NOT carry the answer — a page
    // with both would otherwise show the same verdict twice, a few centimetres
    // apart. The DOI is still read and still preferred for MATCHING; this governs
    // placement only. Pages with a bare DOI and no article metadata (a lab's
    // publication page, a PDF landing page) still get their dot here.
    if (!painted && anchors.length) {
      for (const a of anchors) {
        // Every anchor is judged on its OWN DOI. The page title is only offered
        // as a fallback identity to the anchor that actually IS this page's
        // paper: the one matching the meta DOI, or — when the page states no meta
        // DOI and shows exactly one — that single anchor. Lending the page title
        // to an unrelated DOI (a lab page listing five papers) would paint amber
        // on four papers the title does not describe.
        const ownsPageTitle = pageDoi ? a.doi === pageDoi : anchors.length === 1;
        const v = decide(a.doi, ownsPageTitle ? title : '', index);
        placeDot(a.node, v.state, { ...info0, ...v }, a.doi);
        painted += 1;
      }
    }

    return painted;
  }

  // ────────────────────────────────────────────────────────────────── bootstrap

  function pageLooksLikeAPaper() {
    if (metaDoi(document)) return true;
    if (activeAdapter()) return true;
    if (document.querySelector('a[href*="doi.org/"]')) return true;
    // A citation_title alone marks a paper page even when it carries no DOI (HAL
    // posters, some SPAs) — scan()'s title path can still answer for it.
    if (document.querySelector('meta[name="citation_title" i]')) return true;
    return false;
  }

  // Single-page academic sites (IEEE Xplore, HAL, many publisher apps) render the
  // paper markers — citation meta, the title, the DOI link — client-side, AFTER
  // document-idle. A one-shot check bails before they exist and never comes back,
  // which is why those sites showed no dot at all. So when the page is not yet a
  // paper, poll a few times on a short schedule before giving up. This is NOT a
  // persistent observer: the @match is *://*/*, so this runs on every page, and a
  // plain non-paper page must stop quickly rather than watch forever. A handful of
  // cheap checks costs nothing there and still catches a slow SPA.
  function ensureLooksLikeAPaper() {
    if (pageLooksLikeAPaper()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let tries = 0;
      const MAX_TRIES = 12; // ~9s at 750ms
      const id = setInterval(() => {
        if (pageLooksLikeAPaper()) { clearInterval(id); resolve(true); }
        else if (++tries >= MAX_TRIES) { clearInterval(id); resolve(false); }
      }, 750);
    });
  }

  // A mirror may only answer "not in your library" when it is known to cover the
  // whole library. A build that ran out of MAX_PAGES covers a prefix; a build that
  // came back empty (wrong library id, Zotero mid-startup) covers nothing. Both
  // would otherwise paint confident red on papers Vincent owns.
  function indexIsUsable(meta) {
    return !!meta && meta.complete === true && (meta.doiCount + meta.titleCount) > 0;
  }

  function makeIndex(meta, doiMap, titleMap, creatorMap) {
    const usable = indexIsUsable(meta);
    return {
      doiMap,
      titleMap,
      creatorMap: creatorMap || Object.create(null),
      unusable: !usable,
      unusableReason: usable ? ''
        : (meta && meta.complete !== true
          ? 'library mirror is incomplete — rebuild to get red/green'
          : 'library mirror is empty — rebuild to get red/green'),
    };
  }

  async function loadIndex() {
    const meta = await gm.get(K_META, null);
    if (!meta || meta.cacheVersion !== CACHE_VERSION) return { meta: null, index: null };
    const doiMap = await gm.get(K_DOI, null);
    if (!doiMap) return { meta: null, index: null };
    const titleMap = await gm.get(K_TITLE, {});
    const creatorMap = await gm.get(K_CREATORS, {});
    return { meta, index: makeIndex(meta, doiMap, titleMap, creatorMap) };
  }

  async function main() {
    // The @match is *://*/* so this runs everywhere. Bail before touching storage
    // or the network on the overwhelming majority of pages that are not papers —
    // but give SPAs a few seconds to render their paper markers before giving up.
    if (!(await ensureLooksLikeAPaper())) return;

    injectCss();

    let { meta, index } = await loadIndex();
    if (!meta) meta = { builtAt: 0, checkedAt: 0 }; // never let a scan hit a null meta

    // Paint immediately with whatever we have — grey if that is nothing — so the
    // dot never waits on the network.
    scan(index, meta);

    // Install the observer BEFORE the (multi-second) build below, not after it.
    // Journal pages hydrate and re-render while the index builds; with no observer
    // watching yet, the page can remove the freshly-painted grey dot and nothing
    // re-adds it until the build finishes — the dot visibly blinks out and comes
    // back green. With the observer live from the start, every re-render re-paints:
    // grey while `index` is still null, the real verdict once the build resolves it
    // (rescan reads the `index`/`meta` closures, which the build reassigns below).
    // Inserting a dot is itself a childList mutation, so each scan is wrapped in a
    // disconnect/reconnect + `scanning` guard to stop the observer re-entering on
    // its own output; the live poller below shares that discipline through rescan.
    const target = document.body || document.documentElement;
    const observeOpts = { childList: true, subtree: true };
    let scanning = false;
    let observer;
    function rescan() {
      if (scanning) return;
      scanning = true;
      if (observer) observer.disconnect();
      try { scan(index, meta); } finally {
        scanning = false;
        if (observer) observer.observe(target, observeOpts);
      }
    }
    observer = new MutationObserver(() => {
      if (scanning) return;
      clearTimeout(observer._t);
      observer._t = setTimeout(rescan, 300);
    });
    observer.observe(target, observeOpts);

    try {
      if (!index) {
        const built = await buildIndex();
        meta = built.meta;
        index = makeIndex(built.meta, built.doiMap, built.titleMap, built.creatorMap);
      } else if (Date.now() - (meta.checkedAt || 0) > REFRESH_INTERVAL_MS) {
        const refreshed = await refreshIndex(meta);
        if (refreshed) {
          meta = refreshed.meta;
          index = makeIndex(refreshed.meta, refreshed.doiMap, refreshed.titleMap, refreshed.creatorMap);
        } else {
          meta = { ...meta, checkedAt: Date.now() };
        }
      }
    } catch (e) {
      // Zotero closed, port refused, timeout. Leave the grey dots grey — a red
      // dot here would assert "not in your library" when we simply cannot know.
      // The observer is already installed, so grey dots survive page re-renders.
      console.info('[zotdot] Zotero unreachable:', e.message);
      return;
    }

    // Repaint with the resolved verdict through rescan(), so the observer does not
    // re-fire on this scan's own inserted dots.
    rescan();

    // ── Live refresh: keep the dots current without waiting on a page reload.
    // The userscript cannot be *pushed* to when an item is saved to Zotero —
    // Zotero is a separate process with no channel into the page — so the closest
    // achievable "check when an item is added" is a cheap poll of the same since=
    // check main() runs on load: one request that returns {} when nothing changed
    // (the common case, at zero further cost). Two triggers, both gated on the tab
    // being visible so only the paper Vincent is actually looking at ever polls:
    //   • the tab regaining focus — exactly the shape of "saved to Zotero, then
    //     switched back to the page"; the dot updates the instant he returns.
    //   • a short interval — the backstop for a Connector save that never blurs
    //     the tab, so an item added while the page stays open still lands.
    const LIVE_POLL_MS = 15000;
    let refreshing = false;
    async function liveRefresh() {
      if (refreshing || !index || document.visibilityState !== 'visible') return;
      refreshing = true;
      try {
        const refreshed = await refreshIndex(meta);
        if (refreshed) {
          meta = refreshed.meta;
          index = makeIndex(refreshed.meta, refreshed.doiMap, refreshed.titleMap, refreshed.creatorMap);
          rescan();
        } else {
          meta = { ...meta, checkedAt: Date.now() };
        }
      } catch (e) {
        // Zotero went away mid-session — keep the last good dots and retry next
        // tick, exactly as main() leaves grey dots grey on an unreachable Zotero.
      } finally {
        refreshing = false;
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') liveRefresh();
    });
    window.addEventListener('focus', liveRefresh);
    setInterval(liveRefresh, LIVE_POLL_MS);

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('zotdot: rebuild index', async () => {
          const built = await buildIndex();
          console.info('[zotdot] rebuilt:', built.meta);
          scan(makeIndex(built.meta, built.doiMap, built.titleMap, built.creatorMap), built.meta);
        });
        GM_registerMenuCommand('zotdot: show index status', async () => {
          const m = await gm.get(K_META, null);
          alert(m
            ? `zotdot\nDOIs: ${m.doiCount}\nTitles: ${m.titleCount}\nCursor: ${m.cursor}\nBuilt: ${ageString(m.builtAt)}\nChecked: ${ageString(m.checkedAt)}`
            : 'zotdot: no index built yet');
        });
      }
    } catch (e) { /* menu commands are a convenience, not a requirement */ }
  }

  // ─────────────────────────────────────────────────── export hatch for tests

  const testable = {
    normalizeDoi, normalizeTitle, findDoisInText, foldItems, decide, ageString, SKIP_TYPES,
    asItemArray, asVersionsObject, lookupKey, indexIsUsable, makeIndex,
    creatorSurnames, authorsCorroborate, evictItemKeys,
    titleIsDistinctive,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = testable;
    return; // node: expose pure functions only, never touch the DOM
  }

  main();
})();
