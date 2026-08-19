# zotdot

A userscript that shows at a glance whether papers you browse are already in your local Zotero library.

It works on article pages and search-result listings across sites such as PubMed, Google Scholar, bioRxiv, and other publishers and scholarly databases.

## The four states

| Dot | Meaning |
|---|---|
| 🟢 **Green** | In your Zotero library. Matched by DOI, or by an exact distinctive title when no DOI is available. Click to open the item in Zotero. |
| 🔴 **Red** | Not in your library. Shown only when the local index is available and complete. |
| 🟠 **Amber** | Possible title match, but the title is too short or generic to be reliable without corroborating metadata. Click to open the candidate item. |
| ⚪ **Grey (dashed)** | Unknown — the index has not been built yet, so zotdot cannot tell whether the paper is present. Once built, the index keeps answering even if Zotero is later closed. |

Hover over a dot to see its state, matched Zotero item key, and index age.

## Install

zotdot is browser JavaScript that communicates with Zotero over loopback, so setup is the same on Linux, macOS, and Windows.

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) or Tampermonkey in a Chromium browser or Firefox.
2. In Zotero, enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**.
3. In your userscript manager, create a new script from [`zotdot.user.js`](zotdot.user.js).
4. Open a paper page. zotdot builds its local library index on first use and reuses it across pages.

Requires Zotero 7 or newer; tested against Zotero 10.

You can verify that Zotero's local API is reachable with:

```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:23119/api/users/0/items/top?limit=1
```

A `200` response means the API is reachable.

The browser and Zotero must run on the same machine.

## How it works

zotdot builds a local index of your Zotero library using Zotero's local API, then matches papers by DOI or title. The index is cached in userscript storage and incrementally refreshed while you browse, so checking a paper requires no external metadata service or per-paper network request.

## Supported sites

See [`VALIDATED_SITES.md`](VALIDATED_SITES.md) for sites confirmed to work on live pages, along with known limitations.

## Menu commands

The userscript-manager menu exposes:

- **zotdot: rebuild index** — force a full rebuild
- **zotdot: show index status** — DOI count, title count, cursor, index age

## Troubleshooting

**Grey dashed dot — "index not built yet".** The DOI was found but Zotero could not be reached. Confirm Zotero is running and the local API is enabled (step 2 above); the `curl` check should return `200`. The browser console (F12) logs a line beginning `[zotdot]` naming the failure on reload.

**`[zotdot] Zotero unreachable: network refused`.** Zotero's local API refuses requests carrying an `Origin` header or a `Mozilla/` User-Agent, as an anti-DNS-rebinding measure. zotdot sends a non-browser User-Agent, which a userscript manager with `webRequest` permission (Violentmonkey and Tampermonkey both qualify) can set. If the refusal persists, the manager is adding an `Origin` header the script cannot strip; Firefox with Violentmonkey does not add one.

## Privacy and scope

zotdot is read-only and communicates only with Zotero at `127.0.0.1`.

It uses:

- no Zotero cloud API
- no Crossref or other external metadata service
- no telemetry
- no writes to your Zotero library

zotdot checks whether a paper is present in the library; it does not track whether the item has a PDF attachment.

<details>
<summary><strong>Why does zotdot need these userscript permissions?</strong></summary>

- `@match *://*/*` — allows zotdot to detect papers across publisher and search sites without maintaining a fixed per-site allowlist. On pages that do not contain a paper, the script exits after a lightweight check.
- `@connect 127.0.0.1` — permits requests only to Zotero's local API.
- `GM_xmlhttpRequest` — sends requests to Zotero over loopback and allows the non-browser User-Agent required by Zotero's local API.
- `GM_getValue` / `GM_setValue` — store the cached local index.
- `GM_addStyle` — inject the dot styling.
- `GM_registerMenuCommand` — provides index rebuild and status commands.

</details>

## License

MIT — see [`LICENSE`](LICENSE).
