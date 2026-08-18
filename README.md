# zotdot

A small coloured dot next to a paper's DOI telling you whether it is **already in your Zotero library** — on publisher pages, PubMed, Google Scholar, bioRxiv and other search results.

```
Secure wireless communication of brain–computer interface data
https://doi.org/10.1038/s41467-025-63326-0  ●   ← green: you have it
https://doi.org/10.1038/s41586-099-99999-9  ●   ← red: you don't
```

One userscript. No build step, no dependencies, no server, no telemetry. Your DOIs never leave the machine.

## The four states

| Dot | Meaning |
|---|---|
| 🟢 **Green** | In your library — matched by DOI, or by an exact match on a distinctive title when the page carries no DOI. Click to open the item in Zotero. |
| 🔴 **Red** | The DOI is **not** in your library, and the index is present and complete. |
| 🟠 **Amber** | A title match too short or generic to trust (`Editorial`, `Introduction`), with no author on the page to corroborate it. Offered, not asserted. Click to open. |
| ⚪ **Grey (dashed)** | **Unknown** — Zotero isn't running, or the index hasn't been built yet. A red dot while Zotero is closed would assert "you don't have this" when the truth is "I can't know." |

Hover any dot for its state, the matched Zotero key, and how fresh the index is.

## Install

The script is plain browser JavaScript talking to Zotero over loopback, so it works **identically on Linux, macOS and Windows**. The steps are the same everywhere:

1. **Install a userscript manager** — [Violentmonkey](https://violentmonkey.github.io/) (recommended) or Tampermonkey, in any Chromium browser (Chrome, Edge, Brave) or Firefox.
2. **Enable Zotero's local API.** Zotero → **Settings → Advanced → Allow other applications on this computer to communicate with Zotero.** (Same menu on all three OSes. Requires Zotero 7 or newer; tested against Zotero 10.)
3. **Install the script** — open [`zotdot.user.js`](zotdot.user.js) raw and confirm the install prompt, or drag the file onto the Violentmonkey dashboard.
4. **Visit any paper.** The first paper page builds the index (a few seconds, once); every page after that is instant.

Optional check that the API is reachable — the command is the same on macOS, Linux, and Windows 10+ (PowerShell or CMD, which now ship `curl`):

```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:23119/api/users/0/items/top?limit=1
```

`200` means good. `zotdot: show index status` in the userscript-manager menu confirms the script's own view.

> **Same machine only.** The browser and Zotero must run on the same computer — zotdot talks to `127.0.0.1` and nothing else.

## How it works

Zotero's local API has no working DOI search: querying a real DOI, a nonsense string, or nothing at all returns the same page of items. So zotdot doesn't search — **it mirrors.** The library is a versioned set exposed as an append stream (`Last-Modified-Version` as the cursor, `since=` for the delta), so building a local index of every DOI, title and author surname takes ~18 requests once, and membership is then an in-memory set lookup with zero network cost per dot. That's what makes twenty dots on a Google Scholar page reasonable.

**Live updates.** After a page loads, zotdot keeps the dots current without a reload: it re-checks the moment the tab regains focus — the exact shape of *"saved to Zotero, switched back to the page"* — and polls the cheap change-check every 15 seconds as a backstop, only while the tab is visible. Save a paper to Zotero and its dot turns green within seconds. (A userscript can't be *pushed to* by Zotero, so this is a cheap poll, not a live socket — but in practice the dot updates as fast as you can look back at the page.)

## Where the dot goes

On an **article page** the dot lands on the article **title** — the anchor that always works, since some publishers only print the DOI in a citation block at the very foot of the article. On a **search-results page** each row gets exactly one dot. DOIs inside reference lists are ignored — badging cited works would answer a question you didn't ask.

## Where it's been validated

[`VALIDATED_SITES.md`](VALIDATED_SITES.md) is the exhaustive, hand-curated list of sites where zotdot has been confirmed to work on a live page. It is not final — the list grows as more publishers and search surfaces are checked, and that file's roadmap tracks the ones already on the shortlist.

## Menu commands

The userscript-manager menu exposes:

- **zotdot: rebuild index** — force a full rebuild
- **zotdot: show index status** — DOI count, title count, cursor, index age

## Troubleshooting

**Grey dashed dot — "index not built yet".** The script found the DOI but couldn't reach Zotero. Check Zotero is running and the local API is enabled (step 2 above); the `curl` check should print `200`. Open the browser console (F12) and reload — a line beginning `[zotdot]` names the failure.

**`[zotdot] Zotero unreachable: network refused`.** Zotero's local API deliberately refuses anything that looks like a browser (any `Origin` header, or a `Mozilla/` User-Agent) as an anti-DNS-rebinding defence. zotdot sends a non-browser User-Agent so a userscript manager with `webRequest` permission — Violentmonkey and Tampermonkey both qualify — can reach it. If a refusal persists, your manager is adding an `Origin` header it won't let the script strip: try **Firefox with Violentmonkey**, whose build does not.

## Scope

Read-only, always — no save button, no writes to Zotero. Loopback only — no cloud API, no Crossref, no telemetry. "I have the paper" and "I have the PDF" are different questions; PDF-attachment state is not tracked.
