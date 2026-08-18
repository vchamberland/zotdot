# zotdot

A userscript that places a coloured dot next to a paper's title indicating whether it is present in the local Zotero library. It runs on article pages and on search-results listings (PubMed, Google Scholar, bioRxiv, and others).

## The four states

| Dot | Meaning |
|---|---|
| 🟢 **Green** | In the library — matched by DOI, or by an exact match on a distinctive title when the page carries no DOI. Clicking opens the item in Zotero. |
| 🔴 **Red** | The DOI is not in the library, and the index is present and complete. |
| 🟠 **Amber** | A title match too short or generic to be reliable (e.g. `Editorial`, `Introduction`) with no corroborating author on the page. Clicking opens the candidate item. |
| ⚪ **Grey (dashed)** | Unknown — Zotero is not running, or the index has not been built. Red is never shown in this state, since "not in the library" cannot be distinguished from "cannot check". |

Hovering a dot shows its state, the matched Zotero item key, and the index age.

## Install

The script is browser JavaScript communicating with Zotero over loopback, so it behaves the same on Linux, macOS, and Windows. The steps are identical on all three:

1. Install a userscript manager — [Violentmonkey](https://violentmonkey.github.io/) or Tampermonkey, in a Chromium browser (Chrome, Edge, Brave) or Firefox.
2. Enable Zotero's local API: Zotero → **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. Requires Zotero 7 or newer; tested against Zotero 10.
3. Install the script — in the Violentmonkey dashboard, click the **+** and choose **New from file**, then select [`zotdot.user.js`](zotdot.user.js).
4. Open a paper. The first paper page builds the index (a few seconds, once); subsequent pages use the cached index.

The API can be checked directly (same command on macOS, Linux, and Windows 10+):

```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:23119/api/users/0/items/top?limit=1
```

A `200` response indicates the API is reachable. The **zotdot: show index status** menu command reports the script's own view of the index.

The browser and Zotero must run on the same machine — zotdot only contacts `127.0.0.1`.

## How it works

Zotero's local API does not provide a usable search: a query for a real DOI, a nonsense string, or an empty string all return the same page of items. zotdot therefore does not search; it mirrors the library locally.

The library is exposed as a versioned append stream — `Last-Modified-Version` as a cursor, `since=` for deltas. An initial build pages through every top-level item (about 18 requests for ~8,600 items) and records each item's DOI, title, and author surnames in three maps. Membership is then an in-memory lookup with no network request per dot. The index is cached in userscript storage and reused across pages.

The index is kept current without a page reload: it is refreshed on tab focus and on a 15-second interval while the tab is visible, using the `since=` delta check. A userscript cannot be pushed to by Zotero, so this is polling, not a live connection; a newly saved item appears within the polling interval. Deltas also prune items deleted or edited in Zotero, so a corrected DOI or title does not leave a stale match behind.

## Where the dot goes

On an article page, the dot is placed on the title element. Publisher-specific selectors are tried first, since some pages print the DOI only in a citation block at the foot of the article, making the title the more reliable anchor. On a search-results page, one dot is placed per result row. DOIs occurring inside reference lists are excluded.

Page detection tolerates client-side rendering: on single-page applications the paper markers may appear after load, so detection polls briefly before giving up. Sites that keep the DOI out of the DOM entirely (e.g. IEEE Xplore, which carries it in an inline metadata object) have site-specific extraction.

## Validated sites

[`VALIDATED_SITES.md`](VALIDATED_SITES.md) lists the sites confirmed to work on a live page. It is maintained by hand and extended as sites are checked; it also records sites that are known not to work yet.

## Menu commands

The userscript-manager menu exposes:

- **zotdot: rebuild index** — force a full rebuild
- **zotdot: show index status** — DOI count, title count, cursor, index age

## Troubleshooting

**Grey dashed dot — "index not built yet".** The DOI was found but Zotero could not be reached. Confirm Zotero is running and the local API is enabled (step 2 above); the `curl` check should return `200`. The browser console (F12) logs a line beginning `[zotdot]` naming the failure on reload.

**`[zotdot] Zotero unreachable: network refused`.** Zotero's local API refuses requests carrying an `Origin` header or a `Mozilla/` User-Agent, as an anti-DNS-rebinding measure. zotdot sends a non-browser User-Agent, which a userscript manager with `webRequest` permission (Violentmonkey and Tampermonkey both qualify) can set. If the refusal persists, the manager is adding an `Origin` header the script cannot strip; Firefox with Violentmonkey does not add one.

## Scope

Read-only: no writes to Zotero. Loopback only: no cloud API, no Crossref, no telemetry. "Has the paper" and "has the PDF" are distinct questions; PDF-attachment state is not tracked.

## Permissions

- `@match *://*/*` — the script runs on every page so it can detect papers on any publisher or search site without a per-site allowlist. On a page that is not a paper it exits after a cheap check and does nothing further.
- `@connect 127.0.0.1` — the only network destination is the Zotero local API on loopback; no other host is contacted.
- `GM_xmlhttpRequest` — issues the loopback GET requests to Zotero (also required to set the non-browser User-Agent Zotero's API demands; see Troubleshooting).
- `GM_getValue` / `GM_setValue` — store and read the cached index in userscript storage.
- `GM_addStyle` — inject the dot styling.
- `GM_registerMenuCommand` — register the rebuild / status menu commands.

## License

MIT — see [`LICENSE`](LICENSE).
