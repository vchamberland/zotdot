// ==UserScript==
// @name         zotdot
// @namespace    zotdot
// @version      0.1.0
// @description  Shows a green/red dot next to a paper's DOI depending on whether it is already in your Zotero library
// @author       Vincent Chamberland
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
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
  const CACHE_VERSION = 1;

  const K_META = 'zotdot.meta';
  const K_DOI = 'zotdot.doi';
  const K_TITLE = 'zotdot.title';

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

  function normalizeTitle(raw) {
    if (!raw) return '';
    return String(raw)
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
          ...opts,
          onload: (r) => resolve(r),
          onerror: () => reject(new Error('network')),
          ontimeout: () => reject(new Error('timeout')),
        });
      });
    },
  };

  // ────────────────────────────────────────────────────────────── zotero client

  // Only ever reads, only ever from loopback. Never POST/PUT/DELETE, never a
  // non-loopback host — see the anti-criteria in ISA.md.
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

  function foldItems(items, doiMap, titleMap) {
    for (const it of items) {
      const d = it && it.data;
      if (!d || SKIP_TYPES.has(d.itemType)) continue;
      const doi = normalizeDoi(d.DOI);
      if (doi) {
        doiMap[doi] = d.key;
        continue;
      }
      // Title fallback is only stored for items that have no DOI — that is the
      // only case where it can ever be the deciding signal, and it keeps the
      // cached index roughly half the size it would otherwise be.
      const t = normalizeTitle(d.title);
      if (t) titleMap[t] = d.key;
    }
  }

  async function buildIndex(onProgress) {
    const doiMap = Object.create(null);
    const titleMap = Object.create(null);
    let cursor = 0;
    let schema = '';
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

      const items = asItemArray(JSON.parse(body));
      foldItems(items, doiMap, titleMap);
      if (onProgress) onProgress(start + items.length, headers['total-results']);
      if (items.length < PAGE_SIZE) { complete = true; break; }
    }

    const meta = {
      cacheVersion: CACHE_VERSION,
      cursor,
      schema,
      builtAt: Date.now(),
      checkedAt: Date.now(),
      pages,
      complete,
      doiCount: Object.keys(doiMap).length,
      titleCount: Object.keys(titleMap).length,
    };
    await gm.set(K_DOI, doiMap);
    await gm.set(K_TITLE, titleMap);
    await gm.set(K_META, meta);
    return { meta, doiMap, titleMap };
  }

  // One cheap request. Returns {} when nothing changed, which is the common case.
  async function refreshIndex(meta) {
    const { headers, body } = await zoteroGet(
      `/items/top?since=${meta.cursor}&format=versions`
    );
    const serverVersion = parseInt(headers['last-modified-version'] || '0', 10) || meta.cursor;
    const changed = Object.keys(JSON.parse(body || '{}'));

    if (headers['zotero-schema-version'] && headers['zotero-schema-version'] !== meta.schema) {
      return buildIndex(); // schema moved under us; the cache shape is no longer trustworthy
    }

    const next = { ...meta, checkedAt: Date.now(), cursor: serverVersion };

    if (!changed.length) {
      await gm.set(K_META, next);
      return null; // caller keeps whatever it already loaded
    }

    const doiMap = await gm.get(K_DOI, {});
    const titleMap = await gm.get(K_TITLE, {});

    for (let i = 0; i < changed.length; i += 50) {
      const batch = changed.slice(i, i + 50).join(',');
      const { body: b } = await zoteroGet(`/items?itemKey=${batch}&format=json`);
      foldItems(JSON.parse(b), doiMap, titleMap);
    }

    await pruneDeleted(meta.cursor, doiMap, titleMap);

    next.doiCount = Object.keys(doiMap).length;
    next.titleCount = Object.keys(titleMap).length;
    await gm.set(K_DOI, doiMap);
    await gm.set(K_TITLE, titleMap);
    await gm.set(K_META, next);
    return { meta: next, doiMap, titleMap };
  }

  // Deletions do not show up in `since=`; Zotero exposes them separately.
  // Best-effort: a failure here leaves stale-present entries, which produce a
  // false green — annoying but not destructive, unlike a false red.
  async function pruneDeleted(since, doiMap, titleMap) {
    try {
      const { body } = await zoteroGet(`/deleted?since=${since}`);
      const gone = new Set((JSON.parse(body || '{}').items) || []);
      if (!gone.size) return;
      for (const [k, v] of Object.entries(doiMap)) if (gone.has(v)) delete doiMap[k];
      for (const [k, v] of Object.entries(titleMap)) if (gone.has(v)) delete titleMap[k];
    } catch (e) { /* endpoint absent or errored — keep going */ }
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

    for (const a of root.querySelectorAll('a[href*="doi.org/"], a[href^="doi:"]')) {
      if (inReferenceZone(a)) continue;
      const doi = normalizeDoi(a.getAttribute('href')) || normalizeDoi(a.textContent);
      if (!doi || seen.has(a)) continue;
      seen.add(a);
      found.push({ doi, node: a, source: 'link' });
    }

    if (found.length) return found;

    // Text fallback only. The same DOI printed twice in the same prose is still
    // one identity, so dedupe by value — two dots for one DOI is two answers to
    // one question.
    const seenDoi = new Set();
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
    { host: /scholar\.google\./, rows: '#gs_res_ccl_mid .gs_r.gs_or', title: '.gs_rt' },
    { host: /pubmed\.ncbi\.nlm\.nih\.gov/, rows: 'article.full-docsum', title: '.docsum-title' },
    { host: /(bio|med)rxiv\.org/, rows: '.highwire-article-citation', title: '.highwire-cite-title' },
    { host: /europepmc\.org/, rows: '.resultList > li', title: '.title' },
    { host: /semanticscholar\.org/, rows: '[data-test-id="search-result"]', title: '[data-test-id="title-link"]' },
    { host: /sciencedirect\.com\/search/, rows: '.ResultItem', title: '.result-list-title-link' },
  ];

  function activeAdapter() {
    return ROW_ADAPTERS.find((a) => a.host.test(location.hostname + location.pathname)) || null;
  }

  // ──────────────────────────────────────────────────────────── page: rendering

  const CSS = `
  .zotdot {
    display: inline-block; width: .62em; height: .62em;
    min-width: 8px; min-height: 8px;
    border-radius: 50%; margin: 0 .35em; padding: 0;
    vertical-align: baseline; border: 1px solid rgba(0,0,0,.28);
    box-shadow: 0 0 0 1px rgba(255,255,255,.55);
    cursor: default; flex: none; line-height: 1;
  }
  .zotdot[data-zotdot="hit"]     { background: #16a34a; }
  .zotdot[data-zotdot="miss"]    { background: #dc2626; }
  .zotdot[data-zotdot="title"]   { background: #d97706; }
  .zotdot[data-zotdot="unknown"] { background: transparent; border-style: dashed; border-color: #9ca3af; }
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
      case STATE.HIT: return `In Zotero — DOI match (${info.doi})\n${age}\nClick to open in Zotero`;
      case STATE.TITLE: return `Probably in Zotero — title match only, DOI not recorded\n${age}\nClick to open in Zotero`;
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
  function placeDot(node, state, info, idKey) {
    if (!node || !node.parentNode) return null;
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
    node.parentNode.insertBefore(dot, node.nextSibling);
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

  function decide(doi, title, index) {
    if (!index) return { state: STATE.UNKNOWN, reason: 'index not built yet' };
    if (doi && index.doiMap[doi]) return { state: STATE.HIT, key: index.doiMap[doi], doi };
    const t = normalizeTitle(title);
    if (t && index.titleMap[t]) return { state: STATE.TITLE, key: index.titleMap[t], doi };
    if (!doi && !t) return { state: STATE.UNKNOWN, reason: 'no DOI or title on page' };
    // Red is only reachable from an index we actually have. Every other path is grey.
    return { state: STATE.MISS, doi };
  }

  function scan(index, meta) {
    const info0 = { builtAt: meta.builtAt, checkedAt: meta.checkedAt };
    const adapter = activeAdapter();
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
        const verdict = decide(doi, titleText, index);
        const target = anchors.length ? anchors[0].node : titleEl;
        placeDot(target, verdict.state, { ...info0, ...verdict },
          doi || normalizeTitle(titleText) || 'row');
      }
      return rows.length;
    }

    // Single-paper page.
    const pageDoi = metaDoi(document) || '';
    const title = metaTitle(document);
    const anchors = findDoiAnchors(document.body || document);

    if (anchors.length) {
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
      }
      return anchors.length;
    }

    if (!pageDoi) return 0; // no paper identity on this page — do nothing at all

    // Stated fallback anchor: the article title.
    const verdict = decide(pageDoi, title, index);
    const h1 = document.querySelector('h1');
    if (h1) placeDot(h1.lastChild || h1, verdict.state, { ...info0, ...verdict }, pageDoi);
    return h1 ? 1 : 0;
  }

  // ────────────────────────────────────────────────────────────────── bootstrap

  function pageLooksLikeAPaper() {
    if (metaDoi(document)) return true;
    if (activeAdapter()) return true;
    if (document.querySelector('a[href*="doi.org/"]')) return true;
    return false;
  }

  async function loadIndex() {
    const meta = await gm.get(K_META, null);
    if (!meta || meta.cacheVersion !== CACHE_VERSION) return { meta: null, index: null };
    const doiMap = await gm.get(K_DOI, null);
    if (!doiMap) return { meta: null, index: null };
    const titleMap = await gm.get(K_TITLE, {});
    return { meta, index: { doiMap, titleMap } };
  }

  async function main() {
    // The @match is *://*/* so this runs everywhere. Bail before touching storage
    // or the network on the overwhelming majority of pages that are not papers.
    if (!pageLooksLikeAPaper()) return;

    injectCss();

    let { meta, index } = await loadIndex();
    const provisional = meta || { builtAt: 0, checkedAt: 0 };

    // Paint immediately with whatever we have — grey if that is nothing — so the
    // dot never waits on the network.
    scan(index, provisional);

    try {
      if (!index) {
        const built = await buildIndex();
        meta = built.meta;
        index = makeIndex(built.meta, built.doiMap, built.titleMap);
      } else if (Date.now() - (meta.checkedAt || 0) > REFRESH_INTERVAL_MS) {
        const refreshed = await refreshIndex(meta);
        if (refreshed) {
          meta = refreshed.meta;
          index = makeIndex(refreshed.meta, refreshed.doiMap, refreshed.titleMap);
        } else {
          meta = { ...meta, checkedAt: Date.now() };
        }
      }
    } catch (e) {
      // Zotero closed, port refused, timeout. Leave the grey dots grey — a red
      // dot here would assert "not in your library" when we simply cannot know.
      console.info('[zotdot] Zotero unreachable:', e.message);
      return;
    }

    scan(index, meta);

    // Inserting a dot is itself a childList mutation, so the observer would
    // re-enter on its own output. Detaching around each scan makes that
    // structurally impossible rather than merely unlikely.
    const target = document.body || document.documentElement;
    const observeOpts = { childList: true, subtree: true };
    let scanning = false;
    const observer = new MutationObserver(() => {
      if (scanning) return;
      clearTimeout(observer._t);
      observer._t = setTimeout(() => {
        scanning = true;
        observer.disconnect();
        try { scan(index, meta); } finally {
          scanning = false;
          observer.observe(target, observeOpts);
        }
      }, 300);
    });
    observer.observe(target, observeOpts);

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('zotdot: rebuild index', async () => {
          const built = await buildIndex();
          console.info('[zotdot] rebuilt:', built.meta);
          scan(makeIndex(built.meta, built.doiMap, built.titleMap), built.meta);
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
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = testable;
    return; // node: expose pure functions only, never touch the DOM
  }

  main();
})();
