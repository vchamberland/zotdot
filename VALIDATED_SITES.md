# Validated sites

Sites where zotdot has been **confirmed on a live page** to place a correct dot.
This list is curated by hand: a site earns a row only after it has actually been
checked in the browser — not merely because the code carries an adapter for it.
It is **not exhaustive** and keeps growing; the roadmap at the bottom lists the
surfaces already on the shortlist.

**Verified** is the date the site was last checked. The two sections split
**article pages** (one dot on the title) from **search / results pages** (one dot
per result row).

## Article pages

| Site | Example URL | Verified | Notes |
|------|-------------|----------|-------|
| Annual Reviews | https://www.annualreviews.org | 2026-08-18 | |
| arXiv | https://arxiv.org/abs/2505.03308 | 2026-08-18 | dot on the paper title (v0.8.3) |
| BioRxiv | https://www.biorxiv.org | 2026-08-18 | |
| BMJ Journals | https://neurologyopen.bmj.com | 2026-08-18 | |
| Brain Stimulation | https://www.brainstimjrnl.com | 2026-08-18 | |
| Cell Press | https://www.cell.com | 2026-08-18 | |
| eNeuro | https://www.eneuro.org | 2026-08-18 | |
| Frontiers | https://www.frontiersin.org | 2026-08-18 | |
| IEEE Xplore | https://ieeexplore.ieee.org/abstract/document/6797525 | 2026-08-18 | DOI read from inline metadata (v0.8.4) |
| IOP Science | https://iopscience.iop.org | 2026-08-18 | |
| MDPI | https://www.mdpi.com | 2026-08-18 | |
| Nature | https://www.nature.com | 2026-08-18 | |
| Oxford Academic | https://academic.oup.com | 2026-08-18 | |
| PLOS | https://journals.plos.org | 2026-08-18 | |
| PubMed Central | https://pmc.ncbi.nlm.nih.gov | 2026-08-18 | |
| Science | https://www.science.org | 2026-08-18 | |
| Springer Nature Link | https://link.springer.com | 2026-08-18 | |
| Wiley Online Library | https://onlinelibrary.wiley.com | 2026-08-18 | |

## Search / results pages

| Site | Example URL | Verified | Notes |
|------|-------------|----------|-------|
| Google Scholar | https://scholar.google.ca/scholar?q=hyperscanning | 2026-08-18 | one dot per result row |

## Backlog

Sites checked but not working yet — deferred until further notice; diagnosis noted for whenever they're picked up.

- **HAL** (`hal.science`) — single-page app; at page load it exposes neither a DOI nor `citation_*` meta in the DOM (only a server-rendered `<h1 id="title">`), so zotdot cannot identify the paper. Needs a HAL-specific adapter that reads its metadata. (as of v0.8.3)
- **Google Scholar — citation view** (`scholar.google.*/citations?view_op=view_citation`) — the single-publication detail page, a different layout from the profile table. Scholar exposes no DOI, so it can only be matched by title (`#gsc_oci_title`). Needs a dedicated adapter; hard to verify because Scholar serves a captcha to non-browser fetches. (as of v0.8.4)

## Roadmap — not yet validated

**Search / results surfaces** zotdot carries adapters for but that aren't
confirmed on a live page yet: PubMed search, bioRxiv / medRxiv search,
Europe PMC, Semantic Scholar, ScienceDirect search.

**Known unverified:** Google Scholar profile ("citations") pages — the selectors
come from prior knowledge, not a live check, because Scholar serves a captcha to
non-browser fetches. If profile pages stay bare, that adapter is the thing to fix.

More article hosts and search surfaces will be added as they're checked.
