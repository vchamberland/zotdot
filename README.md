# zotdot

A small coloured dot next to a paper's DOI telling you whether it is **already in your Zotero library**.

```
Secure wireless communication of brain–computer interface data
https://doi.org/10.1038/s41467-025-63326-0  ●   ← green: you have it
https://doi.org/10.1038/s41586-099-99999-9  ●   ← red: you don't
```

Runs in **Violentmonkey** (also works in Tampermonkey — it deliberately avoids Tampermonkey-only APIs). Single file, no build step, no dependencies, no server.

---

## Why it works the way it does

The obvious implementation is to ask Zotero: `GET /api/users/0/items?q=<doi>`. **That does not work.** Zotero 9.0.6's local API silently ignores the `q=` parameter — verified on a live 31,217-item library:

| Query | Results returned |
|---|---|
| `q=10.1038/s41467-025-63326-0` (a DOI that exists) | 100 of 100 requested |
| `q=zzzqqqxxx-nonsense-42` | 100 of 100 requested |
| `q=` (empty) | 100 of 100 requested |

Identical pages every time. `qmode=titleCreatorYear` returns zero for a real DOI; `qmode=everything` returns whatever fills the page. Better BibTeX's JSON-RPC dispatches correctly (a bogus method name returns `-32601`) but `item.search("10.1038/s41467-025-63326-0")` returns `[]` for an item that provably exists.

There is no working search oracle to call. So zotdot doesn't search — **it mirrors.**

The library is a versioned set exposed as an append stream. `Last-Modified-Version` is the cursor, `since=` is the delta, and `/items/top` excludes attachments and notes structurally. Measured on a real library:

| | |
|---|---|
| Top-level items | 8,559 |
| Requests for a full build | **18** (`limit=500`) |
| Full build time | **3.6 s** |
| DOIs indexed | 5,585 |
| Titles indexed (DOI-less items only) | 2,536 |
| Cached index size | **0.36 MB** |
| Cost of a "has anything changed?" check | one request returning `{}` |

Membership then becomes an in-memory set lookup. Painting a dot costs zero network requests, which is what makes twenty dots on a Google Scholar results page reasonable.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/).
2. Make sure Zotero is **running** and its local API is enabled:
   Zotero → Settings → Advanced → *Allow other applications on this computer to communicate with Zotero*.
   Confirm with `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:23119/api/users/0/items/top?limit=1` → `200`.
3. Open `zotdot.user.js` in the browser (or drag it onto the Violentmonkey dashboard) and confirm the install.
4. Visit any paper. The first paper page you open builds the index (~4 s, once); every page after that is instant.

## The four states

| Dot | Meaning |
|---|---|
| 🟢 **Green** | The DOI on this page is in your library. Click to open the item in Zotero. |
| 🔴 **Red** | The DOI is **not** in your library, and the index is present and fresh. |
| 🟠 **Amber** | No DOI match, but a paper with this exact normalized title is in your library — probably the same work, recorded without a DOI. Click to open it. |
| ⚪ **Grey (dashed)** | **Unknown.** Zotero isn't running, or the index hasn't been built yet. |

Grey exists because a red dot while Zotero is closed would assert "you don't have this paper" when the truth is "I can't know." Hover any dot for its state, the matched Zotero key, and how old the index is.

## Where the DOI comes from

Tried in order, based on a survey of Nature, PLOS, Frontiers, bioRxiv, eNeuro and arXiv article pages:

1. `meta[name="citation_doi"]` — present on every publisher surveyed **except arXiv**
2. `meta[name="bepress_citation_doi"]`
3. `meta[name="dc.identifier"]` — bare on PLOS/eNeuro/bioRxiv, `doi:`-prefixed on Nature/Frontiers; both are normalized
4. `meta[name="prism.doi"]`
5. `a#arxiv-doi-link`, else `citation_arxiv_id` → `10.48550/arXiv.<id>` (arXiv ships no `citation_doi` at all)
6. JSON-LD `application/ld+json` (a redundant carrier on Nature and Frontiers)
7. A visible `a[href*="doi.org/"]`
8. A `10.\d{4,9}/…` regex over visible text (Nature prints its DOI as plain text, not a link)

DOIs inside reference lists are excluded — Nature, eNeuro and bioRxiv article pages all carry dozens of `doi.org` links to *cited* works, and badging those would answer a question you didn't ask.

## Multi-result pages

Google Scholar, PubMed search, bioRxiv/medRxiv search, Europe PMC, Semantic Scholar and ScienceDirect search get one dot per result row.

**Google Scholar carries no DOI anywhere** — not per row, not in meta tags (verified: zero occurrences of `doi.org` in the served HTML). Rows there are matched on normalized title only, so a match shows amber rather than green. That is an honest limit, not a bug.

## Menu commands

Violentmonkey's script menu exposes:

- **zotdot: rebuild index** — force a full rebuild
- **zotdot: show index status** — DOI count, title count, cursor, index age

## Tests

```bash
node --check zotdot.user.js     # syntax
node test/pure.test.cjs         # 29 assertions, pure functions, no network
node test/live-index.cjs        # integration against your running Zotero
```

`live-index.cjs` exercises the same `foldItems()` the userscript uses, over your real library, and checks request count, map population, cursor capture, a known-present DOI resolving, a fabricated DOI not resolving, and `since=` returning empty immediately after a build. It exits `2` if Zotero isn't running.

## Troubleshooting

### Grey dashed dot: "Unknown — index not built yet"

The script is running and found the DOI, but it could not reach Zotero. Check in order:

1. **Is Zotero running?** `curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:23119/api/users/0/items/top?limit=1'` must print `200`. If it prints nothing, start Zotero; if it prints `404`, enable *Settings → Advanced → Allow other applications on this computer to communicate with Zotero*.
2. **Open the browser console** (F12) on the article page and reload. A line beginning `[zotdot]` names the failure.

### `[zotdot] Zotero unreachable: network refused …`

**Zotero's local API deliberately refuses browsers.** Measured against Zotero 9.0.6, its HTTP server drops the connection (empty reply, no status line) for:

| Request | Result |
|---|---|
| no `Origin`, plain User-Agent | **200** |
| **any** `Origin` header — including empty, `null`, `http://127.0.0.1:23119`, `https://www.zotero.org` | dropped |
| `User-Agent` containing `Mozilla/` — even with no `Origin` | dropped |
| `User-Agent: Chrome/151`, `python-requests/2.31`, `zotdot/0.1` | 200 |
| `Referer` or `X-Requested-With`, no `Origin` | 200 |

This is an anti-DNS-rebinding defence, not a bug: it stops any web page from talking to your library. It also means the client must simply **not look like a browser**, which is why zotdot sends `User-Agent: zotdot/0.1` and `anonymous: true` on every request. Violentmonkey can rewrite those restricted headers because it holds `webRequest` and `declarativeNetRequestWithHostAccess` permissions.

Note that Zotero answers `OPTIONS` with `200` and **no** `Access-Control-Allow-Origin` header — it grants CORS to nobody, so a page-context `fetch` can never work regardless.

If the console still reports a refusal after this, the userscript manager is attaching an `Origin` header that cannot be suppressed from script. Fallbacks, best first:

- **Try Firefox** with Violentmonkey — a different manager build may not add `Origin`.
- **Run a tiny loopback relay** that accepts browser requests and forwards them to Zotero with the headers stripped. This reintroduces a background process, which v1 deliberately avoided.

### Not the cause: Local Network Access

Chromium 151 does gate loopback behind a per-origin Local Network Access permission (visible in the browser profile as a `local_network` content setting), and `brave://flags#local-network-access-check` disables it globally. On this setup that was **not** the blocker — disabling it changed nothing, and the real cause was the header filtering above. Rule it out quickly rather than dwelling on it.

## Not in v1

- **PDF-attachment state.** "I have the paper" and "I have the PDF" are different questions; the second needs a child-item pass per key.
- **Writing to Zotero.** No save button, no duplicate merge. Read-only, always.
- **Any network destination other than `127.0.0.1`.** No cloud API, no Crossref, no telemetry. Your DOIs never leave the machine.
- **Cross-machine use.** This assumes Zotero runs on the same machine as the browser.

## Files

| Path | What it is |
|---|---|
| `zotdot.user.js` | the userscript — the whole product |
| `ISA.md` | ideal-state artifact: problem, criteria, test strategy, decisions |
| `test/pure.test.cjs` | pure-function tests (normalization, folding, verdicts) |
| `test/live-index.cjs` | live integration check against Zotero |
| `test/fixture/` | offline visual harness with a shimmed `GM_*` environment |
