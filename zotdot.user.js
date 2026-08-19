// ==UserScript==
// @name         zotdot
// @namespace    zotdot
// @version      0.8.9
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
 * zotdot — badges whether a paper is already in your local Zotero library.
 * The local API has no working search, so instead of searching it mirrors the
 * library into local maps (/items/top paged once, kept current via since= deltas)
 * and does an O(1) lookup. Read-only, loopback only.
 */

(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────── configuration

  const API = 'http://127.0.0.1:23119/api/users/0';
  const PAGE_SIZE = 500;          // local API honors this; the web API caps at 100
  const MAX_PAGES = 40;           // hard stop, ~20k top-level items
  const REFRESH_INTERVAL_MS = 120000;
  const VERSION = '0.8.9';
  // Must NOT contain "Mozilla/" — see the note in gm.request().
  const UA = `zotdot/${VERSION} (local Zotero client)`;
  // Opt-in console tracing, toggled from the userscript menu, persisted in GM
  // storage. Off by default — one `[zotdot] vX loaded` line is always emitted so
  // the running version is visible without enabling anything.
  let DEBUG = false;
  const dlog = (...a) => { if (DEBUG) console.info('[zotdot]', ...a); };
  // Cache shape version. Bumped when the stored maps/meta change (v4: creator
  // surnames; v5: Zotero-Server-ID, so a cache from another database is rebuilt;
  // v6: force a clean rebuild to drop items a pre-fix build left green after they
  // were trashed — the old /deleted-based prune never evicted them, and a delta
  // can't repair a cache whose cursor already advanced past the deletion).
  const CACHE_VERSION = 6;

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

  // DOIs are case-insensitive but stored inconsistently; normalize both sides of
  // the comparison to the same shape or nothing matches.
  function normalizeDoi(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toLowerCase();
    s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
    s = s.replace(/^https?:\/\/doi\.org\//, '');
    s = s.replace(/^info:doi\//, '');
    s = s.replace(/^doi:\s*/, '');
    // DOIs are routinely printed parenthesised or sentence-final; strip enclosers.
    s = s.replace(/^[\s([{<"'‹«]+/, '');
    s = s.replace(/[\s.,;:)\]}>"'›»]+$/, '');
    return /^10\.\d{4,9}\/\S+$/.test(s) ? s : '';
  }

  // Result listings prefix titles with a format tag (Scholar: "[HTML] …", "[PDF] …",
  // "[BOOK] …"); strip it or the tag becomes part of the key and never matches.
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

  // Build a useful error string from whatever fields the userscript manager hands
  // back (they vary by manager/version), with a hint about the loopback refusal.
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
          // Zotero's local API drops any request with an `Origin` header or a
          // "Mozilla/" User-Agent (anti-DNS-rebinding), so the client must not look
          // like a browser. Violentmonkey can set these restricted headers.
          anonymous: true,
          ...opts,
          // Zotero sends no Cache-Control/ETag/Last-Modified, so the browser is free
          // to serve a stale /items/top or /items/trash from before a trash — which
          // painted deleted papers green even after a rebuild. Force a revalidated
          // (here, full) refetch every time; the hot path must read current truth.
          headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...(opts.headers || {}) },
          onload: (r) => resolve(r),
          // Surface the manager's error fields so the next failure names itself.
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
    // Also bust the cache via a unique param (belt-and-suspenders with the no-cache
    // headers) — Zotero ignores unknown query params, so `_=` is inert to it.
    const bust = `${path.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const res = await gm.request({ url: `${API}${path}${bust}` });
    if (res.status !== 200) throw new Error(`zotero ${res.status}`);
    const headers = {};
    for (const line of String(res.responseHeaders || '').trim().split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { headers, body: res.responseText };
  }

  // A 200 with an unexpected body must not become the index: a non-array would fold
  // into a near-empty mirror and paint red on the whole library. Throw → main stays grey.
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

  // Lowercased surnames for corroborating a title match against a result page's
  // author line. Zotero creators are {lastName} or a single {name} (institutions).
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

  // True when an indexed surname appears as a whole word in the page's author line.
  // Initials collapse to 1-2 char tokens, so only real surnames match.
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
      // Index EVERY item's title, even DOI-bearing ones: Google Scholar rows carry
      // no DOI, so the title is the only signal available there.
      const t = normalizeTitle(d.title);
      if (t && !titleMap[t]) titleMap[t] = d.key;
    }
  }

  // Remove every DOI/title/creator entry pointing at one of `keys`. foldItems only
  // adds, so an item whose DOI/title was edited would keep its old value forever (a
  // false green); the delta evicts before re-folding. Mutates in place, pure.
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
    // Only a short final page proves we reached the library's end; hitting MAX_PAGES
    // means the mirror is a prefix, which cannot answer "absent" (see indexIsUsable).
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

    // A different database (switched account / restored backup) can reuse the same
    // version numbers, so since= would fold the wrong library's deltas in. Zotero 10
    // tags each database with a stable Zotero-Server-ID; if it changed, rebuild.
    const serverId = headers['zotero-server-id'] || '';
    if (serverId && meta.serverId && serverId !== meta.serverId) {
      return buildIndex();
    }

    if (headers['zotero-schema-version'] && headers['zotero-schema-version'] !== meta.schema) {
      return buildIndex(); // schema moved under us; the cache shape is no longer trustworthy
    }

    dlog('refresh: cursor', meta.cursor, '→ server', serverVersion, '| changed', changed.length);

    // Library version unchanged → nothing added/edited/deleted (the common case).
    if (serverVersion === meta.cursor && !changed.length) {
      dlog('refresh: no-op — nothing changed since cursor');
      await gm.set(K_META, { ...meta, checkedAt: Date.now(), serverId: meta.serverId || serverId });
      return null; // caller keeps whatever it already loaded
    }

    const doiMap = await gm.get(K_DOI, null);
    const titleMap = (await gm.get(K_TITLE, null)) || Object.create(null);
    const creatorMap = (await gm.get(K_CREATORS, null)) || Object.create(null);
    // Fold the delta into the EXISTING maps. An empty/missing DOI map would persist
    // a handful of items as the whole library (mass false red) — rebuild instead.
    if (!doiMap || !Object.keys(doiMap).length) return buildIndex();

    // Evict each edited item's stale DOI/title before re-folding its fresh copy;
    // new items have no prior entry (no-op). pruneDeleted (below) handles vanished items.
    evictItemKeys(changed, doiMap, titleMap, creatorMap);

    for (let i = 0; i < changed.length; i += 50) {
      const batch = changed.slice(i, i + 50).join(',');
      const { body: b } = await zoteroGet(`/items?itemKey=${batch}&format=json`);
      foldItems(asItemArray(JSON.parse(b)), doiMap, titleMap, creatorMap);
    }

    // A trashed item just vanishes from /items/top?since=, so `changed` can be empty
    // while the version moved. Prune whenever the version moved, always against the
    // PRE-refresh cursor — once it advances past a trashing, the trash window that
    // named that key may have scrolled out of a since= range that starts later.
    const pruneResult = await pruneDeleted(meta.cursor, doiMap, titleMap, creatorMap);

    // Hold the cursor back when the trash window couldn't be read, so the next refresh
    // retries it. A Zotero with no trash endpoint at all: advance, surface on rebuild.
    const nextCursor = pruneResult === 'failed' ? meta.cursor : serverVersion;
    const next = { ...meta, checkedAt: Date.now(), cursor: nextCursor, serverId: meta.serverId || serverId };
    next.doiCount = Object.keys(doiMap).length;
    next.titleCount = Object.keys(titleMap).length;
    next.creatorCount = Object.keys(creatorMap).length;
    dlog('refresh: prune', pruneResult, '| DOIs', meta.doiCount, '→', next.doiCount, '| nextCursor', nextCursor);
    await gm.set(K_DOI, doiMap);
    await gm.set(K_TITLE, titleMap);
    await gm.set(K_CREATORS, creatorMap);
    await gm.set(K_META, next);
    return { meta: next, doiMap, titleMap, creatorMap };
  }

  // Deletions aren't in /items/top?since= — a trashed item just vanishes from it.
  // Zotero's LOCAL API has no /deleted endpoint (it 404s), so read the trash directly:
  // /items/trash?since=<cursor>&format=versions lists every item trashed since the
  // cursor as a {key: version} object. Evict those keys. Returns 'pruned' (window
  // read), 'unsupported' (no trash endpoint at all), or 'failed' (request broke) so
  // the caller can decide whether the cursor may advance past this window.
  async function pruneDeleted(since, doiMap, titleMap, creatorMap) {
    let body;
    try {
      ({ body } = await zoteroGet(`/items/trash?since=${since}&format=versions`));
    } catch (e) {
      return /zotero (404|501)/.test(e.message) ? 'unsupported' : 'failed';
    }
    let gone;
    try {
      gone = new Set(Object.keys(asVersionsObject(JSON.parse(body || '{}'))));
    } catch (e) {
      return 'failed'; // unparseable body — treat the window as unread
    }
    dlog('prune: /items/trash?since=' + since, '→', gone.size, 'trashed keys in window');
    evictItemKeys(gone, doiMap, titleMap, creatorMap);
    return 'pruned';
  }

  // ────────────────────────────────────────────────────────── page: extraction

  // Empirical order (Nature, PLOS, Frontiers, bioRxiv, eNeuro, arXiv): citation_doi
  // is on every site but arXiv; dc.identifier is bare or `doi:`-prefixed (both fold).
  const META_DOI_KEYS = [
    'citation_doi',
    'bepress_citation_doi',
    'dc.identifier',
    'dc.identifier.doi',
    'prism.doi',
  ];

  // IEEE Xplore (Angular) never exposes the DOI as a <meta> or doi.org link — only
  // inside an inline `xplGlobal.document.metadata` script, present from first paint.
  // Read it there. Host-gated so no other page pays for the script scan.
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
    // arXiv ships no citation_doi — only its minted DOI, as a link id. Fall back to
    // that, then to constructing it from the arXiv id.
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

  // The article's own title element, publisher classes first — a bare `h1` is the
  // journal name or a site banner on some sites, so it comes last.
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

  // Reference lists carry many doi.org links to CITED works; an unscoped selector
  // would badge those instead of the article. (Nature, eNeuro, bioRxiv verified.)
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

  // Visible DOI anchors in preference order, so the dot lands where the reader is
  // already looking rather than somewhere structurally convenient.
  function findDoiAnchors(root) {
    const found = [];
    const seen = new Set();
    // Dedupe by value — the same DOI printed twice is still one identity.
    const seenDoi = new Set();

    for (const a of root.querySelectorAll('a[href*="doi.org/"], a[href^="doi:"]')) {
      if (inReferenceZone(a)) continue;
      const doi = normalizeDoi(a.getAttribute('href')) || normalizeDoi(a.textContent);
      if (!doi || seen.has(a)) continue;
      seen.add(a);
      seenDoi.add(doi);
      found.push({ doi, node: a, source: 'link' });
    }

    // Do NOT early-return when links were found: Nature prints the article's own DOI
    // as plain text while linking dozens of CITED DOIs, so a page can carry both and
    // the text-only one matters more. (Early-returning left the Nature case unbadged.)

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

  // Multi-result pages: one dot per row, where a single-DOI-per-page assumption breaks.
  const ROW_ADAPTERS = [
    // Scholar profile ("citations") pages use a table, not .gs_r blocks. NOTE: these
    // two selectors are from prior knowledge, unverified (Scholar captchas non-browser
    // fetches). If profile pages stay bare, these are the strings to correct.
    { host: /scholar\.google\./, rows: '#gsc_a_b .gsc_a_tr', title: '.gsc_a_at', authors: '.gs_gray', distinctive: true },
    { host: /scholar\.google\./, rows: '#gs_res_ccl_mid .gs_r.gs_or', title: '.gs_rt', authors: '.gs_a', distinctive: true },
    { host: /pubmed\.ncbi\.nlm\.nih\.gov/, rows: 'article.full-docsum', title: '.docsum-title', authors: '.docsum-authors', distinctive: true },
    { host: /(bio|med)rxiv\.org/, rows: '.highwire-article-citation', title: '.highwire-cite-title', authors: '.highwire-citation-authors', distinctive: true },
    { host: /europepmc\.org/, rows: '.resultList > li', title: '.title', authors: '.authors' },
    { host: /semanticscholar\.org/, rows: '[data-test-id="search-result"]', title: '[data-test-id="title-link"]', authors: '[data-test-id="author-list"]' },
    { host: /sciencedirect\.com\/search/, rows: '.ResultItem', title: '.result-list-title-link', authors: '.Authors' },
  ];

  // `distinctive: true` = a rows-selector specific enough to identify the platform on
  // its own, so the adapter activates structurally (survives regional domains, proxies,
  // HighWire journals). Generic selectors stay host-gated to avoid false hits.
  function rowsPresent(a) {
    try { return !!document.querySelector(a.rows); } catch (e) { return false; }
  }

  function activeAdapter() {
    const here = location.hostname + location.pathname;
    const onThisHost = ROW_ADAPTERS.filter((a) => a.host.test(here));
    // One host can serve several layouts (Scholar: search + profile); pick the
    // adapter whose rows actually exist here.
    for (const a of onThisHost) if (rowsPresent(a)) return a;
    for (const a of ROW_ADAPTERS) if (a.distinctive && rowsPresent(a)) return a;
    // A known host with no rows yet (loading/empty) is still not an article page —
    // return the host adapter so the single-paper branch doesn't badge nav headings.
    return onThisHost[0] || null;
  }

  // ──────────────────────────────────────────────────────────── page: rendering

  // Indicator-lamp styling. The halo is sized in em so it scales with page type; the
  // `unknown` state is an unlit lamp (dim, no halo) so "couldn't check" never looks confident.
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

  // Idempotency keyed on (node, DOI), not node alone: one element can carry several
  // DOIs (a text anchor is the shared parent), and a node-only guard would collide.
  const painted = new WeakMap(); // node -> Map<doiKey, dotElement>

  // `idKey` must come from stable page data (anchor DOI, or row title), never the
  // verdict — the verdict's DOI is empty pre-index and set after, which would key the
  // same anchor twice and stack two dots. `inside: true` appends the dot as the last
  // child instead of after `node`, so a moving lastChild can't spawn a second dot.
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

  // Maps are Object.create(null) but round-trip through JSON storage with
  // Object.prototype attached; a title like "Constructor" normalizes to `constructor`,
  // so use hasOwnProperty, not a bare map[key] that would hit the prototype.
  function lookupKey(map, key) {
    if (!map || !key) return '';
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
  }

  // A title must be long and wordy enough that two unrelated papers won't share it.
  const TITLE_GREEN_MIN_CHARS = 25;
  const TITLE_GREEN_MIN_WORDS = 4;

  function titleIsDistinctive(t) {
    if (!t || t.length < TITLE_GREEN_MIN_CHARS) return false;
    return t.split(' ').filter(Boolean).length >= TITLE_GREEN_MIN_WORDS;
  }

  function decide(doi, title, index, pageAuthors) {
    if (!index) return { state: STATE.UNKNOWN, reason: 'index not built yet' };
    // A mirror that can't answer "absent" must never say "absent"; hits still hold.
    const doiKey = lookupKey(index.doiMap, doi);
    if (doi && doiKey) return { state: STATE.HIT, key: doiKey, doi };
    const t = normalizeTitle(title);
    const titleKey = lookupKey(index.titleMap, t);
    if (t && titleKey) {
      // An exact match on a long distinctive title is green; Scholar has no DOI, so
      // holding every row at amber would be no signal. Short/generic titles stay amber.
      if (titleIsDistinctive(t)) return { state: STATE.HIT, key: titleKey, doi, via: 'title' };
      // A short title alone collides, but a short title + an author printed on the
      // page is a different claim — promote to green.
      if (authorsCorroborate(lookupKey(index.creatorMap, titleKey), pageAuthors)) {
        return { state: STATE.HIT, key: titleKey, doi, via: 'title+author' };
      }
      return { state: STATE.TITLE, key: titleKey, doi, via: 'title' };
    }
    if (index.unusable) {
      return { state: STATE.UNKNOWN, reason: index.unusableReason || 'index incomplete', doi };
    }
    if (!doi && !t) return { state: STATE.UNKNOWN, reason: 'no DOI or title on page' };
    // Red is only reachable from a complete index we hold; every other path is grey.
    return { state: STATE.MISS, doi };
  }

  function scan(index, meta) {
    const info0 = { builtAt: meta.builtAt, checkedAt: meta.checkedAt };
    const pageDoi = metaDoi(document) || '';

    // An article page embedding a results-shaped list ("related articles") is still an
    // article page: its own citation_doi outranks any row match, so the dot lands on it.
    const adapter = pageDoi ? null : activeAdapter();
    const rows = adapter ? Array.from(document.querySelectorAll(adapter.rows)) : [];

    if (rows.length) {
      for (const row of rows) {
        const titleBlock = row.querySelector(adapter.title) || row.querySelector('a');
        if (!titleBlock) continue;
        // Anchor to the inner link, not the <h3>, or the dot drops to its own line.
        const titleEl = titleBlock.querySelector('a') || titleBlock;
        const anchors = findDoiAnchors(row);
        const doi = anchors.length ? anchors[0].doi : '';
        const titleText = titleEl.textContent || '';
        // The row's author line corroborates a short title match.
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

    // Badge the article title whenever the page has a paper identity, not only as a
    // DOI fallback: some publishers print the DOI only in a footer citation block,
    // long after you've scrolled past. The title is always at the top.
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


    // Only badge a visible DOI when the title couldn't carry the answer, else the same
    // verdict shows twice. The DOI is still read and preferred for MATCHING; this is
    // placement only. A bare DOI with no article metadata still gets its dot here.
    if (!painted && anchors.length) {
      for (const a of anchors) {
        // Each anchor is judged on its OWN DOI. The page title is lent only to the
        // anchor that IS this page's paper (matches the meta DOI, or the sole anchor
        // when there's no meta DOI) — lending it to a lab page's other papers is wrong.
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
    // A citation_title alone marks a paper page even without a DOI (HAL posters, SPAs).
    if (document.querySelector('meta[name="citation_title" i]')) return true;
    return false;
  }

  // SPAs (IEEE Xplore, HAL, many publisher apps) render paper markers after
  // document-idle; a one-shot check bails before they exist and never retries. Poll
  // briefly before giving up. NOT a persistent observer — @match is *://*/*, so a
  // plain non-paper page must stop quickly; a few cheap checks catch a slow SPA.
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

  // A mirror may only say "not in your library" when it covers the whole library. A
  // build that hit MAX_PAGES covers a prefix; an empty build covers nothing. Either
  // would paint confident red on papers you own.
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
    // @match is *://*/*, so bail on non-paper pages before touching storage/network —
    // but give SPAs a few seconds to render their markers first.
    if (!(await ensureLooksLikeAPaper())) return;

    DEBUG = await gm.get('zotdot.debug', false);
    console.info(`[zotdot] v${VERSION} loaded${DEBUG ? ' (debug on)' : ''}`);

    injectCss();

    let { meta, index } = await loadIndex();
    if (!meta) meta = { builtAt: 0, checkedAt: 0 }; // never let a scan hit a null meta

    // Paint immediately with whatever we have (grey if nothing) — never wait on network.
    scan(index, meta);

    // Install the observer BEFORE the multi-second build: journal pages re-render
    // while it runs and would drop the grey dot with nothing to re-add it (it blinks
    // out, then returns green). rescan reads the index/meta closures the build
    // reassigns; the disconnect + `scanning` guard stops re-entry on our own inserts.
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
      // Zotero closed/refused/timed out: leave grey dots grey (red would assert
      // "not in your library" when we can't know). The observer stays installed.
      console.info('[zotdot] Zotero unreachable:', e.message);
      return;
    }

    // Repaint the resolved verdict via rescan() so the observer doesn't re-fire on it.
    rescan();

    // Live refresh: keep dots current without a reload. A userscript can't be pushed
    // to by Zotero, so poll the cheap since= check — on tab focus (the "saved, then
    // switched back" case) and on a short interval as a backstop — both gated on the
    // tab being visible so only the page you're looking at ever polls.
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
        // Zotero went away mid-session: keep the last good dots, retry next tick.
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
            ? `zotdot v${VERSION}\nDOIs: ${m.doiCount}\nTitles: ${m.titleCount}\nCursor: ${m.cursor}\nCache: v${m.cacheVersion}\nBuilt: ${ageString(m.builtAt)}\nChecked: ${ageString(m.checkedAt)}`
            : `zotdot v${VERSION}: no index built yet`);
        });
        GM_registerMenuCommand('zotdot: toggle debug logging', async () => {
          DEBUG = !(await gm.get('zotdot.debug', false));
          await gm.set('zotdot.debug', DEBUG);
          alert(`zotdot debug logging: ${DEBUG ? 'ON' : 'OFF'}\nReload the page to see [zotdot] lines in the console (F12).`);
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
    // Network/storage-backed internals, exported so a node harness can drive the
    // full sync flow against a live Zotero (they no-op safely without GM_* shims).
    buildIndex, refreshIndex, pruneDeleted, loadIndex, gm,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = testable;
    return; // node: expose pure functions only, never touch the DOM
  }

  main();
})();
