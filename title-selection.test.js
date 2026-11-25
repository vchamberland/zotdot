import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual userscript functions without starting its Zotero client.
const source = readFileSync(new URL('./zotdot.user.js', import.meta.url), 'utf8');
const normalizing = source.slice(source.indexOf('  const LISTING_PREFIX'), source.indexOf('  const DOI_RE'));
const selection = source.slice(source.indexOf('  function metaTitle('), source.indexOf('  // Reference lists'));
function select({ metadata = '', headings = [], selectors = {}, title = '' }) {
  const document = {
    title,
    querySelectorAll(s) {
      if (s === 'h1, h2, h3') return headings;
      return metadata ? [{ getAttribute: () => metadata }] : [];
    },
    querySelector(s) { return selectors[s] || null; },
  };
  return runInNewContext(`${normalizing}\n${selection}\narticleTitleElement()`, { document });
}

test('APS: citation title wins over the first h1 journal banner', () => {
  const journal = { textContent: 'Physical Review Research' };
  const paper = { textContent: 'Information-theoretic description of a feedback-control Kuramoto model' };
  expect(select({ metadata: paper.textContent, headings: [journal, paper], selectors: { h1: journal } })).toBe(paper);
});

test('metadata-matched h2/h3 wins even with a site h1 and publisher selector', () => {
  const banner = { textContent: 'Journal' };
  const paper = { textContent: 'A paper title' };
  expect(select({ metadata: paper.textContent, headings: [banner, paper], selectors: { h1: banner, 'h1.title': banner } })).toBe(paper);
});

test('publisher selector remains the fallback when metadata does not match', () => {
  const paper = { textContent: 'Rendered paper title' };
  expect(select({ metadata: 'Different metadata', headings: [paper], selectors: { 'h1.c-article-title': paper } })).toBe(paper);
});

test('no metadata: publisher selector still beats generic h1', () => {
  const journal = { textContent: 'Journal' };
  const paper = { textContent: 'A paper' };
  expect(select({ headings: [journal, paper], selectors: { h1: journal, 'h1.title': paper } })).toBe(paper);
});

test('no headings returns null', () => {
  expect(select({ metadata: 'Missing title' })).toBeNull();
});
