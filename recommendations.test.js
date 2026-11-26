import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./zotdot.user.js', import.meta.url), 'utf8');
const normalization = source.slice(source.indexOf('  function normalizeDoi('), source.indexOf('  const DOI_RE'));
const matching = source.slice(source.indexOf('  function lookupKey('), source.indexOf('  // ────────────────────────────────────────────────────────────────── bootstrap'));
const placement = source.slice(source.indexOf('  const painted = new WeakMap'), source.indexOf('  function paintDot('));
const selector = '[data-test="article-recommendations"] .c-article-recommendations-card__heading a';

function setup(hostname = 'www.nature.com') {
  const main = { textContent: 'The main article title' };
  const dots = [];
  function card(title, doi) {
    return {
      textContent: title,
      getAttribute: (name) => name === 'data-track-label' ? doi : null,
      parentNode: { insertBefore(dot) { dot.isConnected = true; dots.push(dot); } },
    };
  }
  const cards = [
    card('Advancing neuroengineering with Neuromorphic Twins', '10.1038/s41467-026-68923-1'),
    card('Translational opportunities and challenges of invasive electrodes for neural interfaces', '10.1038/s41551-023-01021-5'),
    card('Non-invasive brain stimulation: current and future applications in neurology', null),
    card('', null),
  ];
  const index = {
    doiMap: { '10.1038/main': 'MAIN', '10.1038/s41467-026-68923-1': 'FIRST' },
    titleMap: { 'non invasive brain stimulation current and future applications in neurology': 'THIRD' },
    creatorMap: {},
  };
  const context = {
    location: { hostname },
    document: {
      body: {},
      querySelectorAll: (s) => { expect(s).toBe(selector); return cards; },
      querySelector: () => null,
      createElement: () => ({ dataset: {} }),
    },
    STATE: { HIT: 'hit', MISS: 'miss', UNKNOWN: 'unknown', TITLE: 'title' },
    metaDoi: () => '10.1038/main',
    metaTitle: () => main.textContent,
    articleTitleElement: () => main,
    activeAdapter: () => { throw new Error('Article must not become a listing'); },
    findDoiAnchors: () => [],
    authorsCorroborate: () => false,
    paintDot: (dot, state, info) => { dot.state = state; dot.info = info; },
    verifyAndCorrect: () => {},
    index,
    meta: { builtAt: 1, checkedAt: 2 },
  };
  main.appendChild = (dot) => { dot.isConnected = true; dots.push(dot); };
  return { context, dots, cards };
}
function run(context) {
  return runInNewContext(`${normalization}\n${placement}\n${matching}\n({ scan, scanRecommendations })`, context);
}

test('Nature article keeps its own dot and independently badges recommendation titles', () => {
  const { context, dots } = setup();
  const { scan } = run(context);
  expect(scan(context.index, context.meta)).toBe(4);
  expect(dots.map((d) => d.state)).toEqual(['hit', 'hit', 'miss', 'hit']);
  expect(dots.map((d) => d.info.key)).toEqual(['MAIN', 'FIRST', undefined, 'THIRD']);
  expect(dots[2].info.doi).toBe('10.1038/s41551-023-01021-5');
  expect(dots[3].info.doi).toBe('');
  // Real placement code must update dots rather than duplicate them on rescan.
  expect(scan(context.index, context.meta)).toBe(4);
  expect(dots.length).toBe(4);
});

test('recommendations remain unknown with an incomplete index and no match', () => {
  const { context, dots } = setup();
  context.index = { doiMap: {}, titleMap: {}, unusable: true };
  run(context).scanRecommendations(context.index, {});
  expect(dots.map((d) => d.state)).toEqual(['unknown', 'unknown', 'unknown']);
});

test('a late-added recommendation is picked up by the next scan', () => {
  const { context, dots, cards } = setup();
  const late = cards.splice(1);
  const { scan } = run(context);
  expect(scan(context.index, context.meta)).toBe(2);
  cards.push(...late);
  expect(scan(context.index, context.meta)).toBe(4);
  expect(dots.length).toBe(4);
});

for (const hostname of ['example.com', 'nature.com.example.com', 'notnature.com']) {
  test(`recommendation scan does not touch ${hostname}`, () => {
    const { context, dots } = setup(hostname);
    expect(run(context).scanRecommendations(context.index, {})).toBe(0);
    expect(dots).toEqual([]);
  });
}
