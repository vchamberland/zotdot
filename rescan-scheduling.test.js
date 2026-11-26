import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the actual observer setup with a deterministic clock, not real page timing.
const source = readFileSync(new URL('./zotdot.user.js', import.meta.url), 'utf8');
const start = source.indexOf('    const target = document.body');
const setup = source.slice(start, source.indexOf('\n    try {', start));
function harness() {
  let now = 0;
  let next = 0;
  let notify;
  const timers = new Map();
  const scans = [];
  class Observer {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() {}
  }
  runInNewContext(setup, {
    document: { body: {} }, index: {}, meta: {},
    MutationObserver: Observer,
    scan: () => scans.push(now),
    setTimeout(fn, delay) {
      timers.set(++next, { fn, at: now + delay });
      return next;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    scans,
    mutate: () => notify([]),
    advance(to) {
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= to)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = to;
    },
  };
}

test('continuous publisher mutations cannot starve dot recovery', () => {
  const h = harness();
  for (let t = 0; t <= 5000; t += 100) {
    h.advance(t);
    h.mutate();
  }
  expect(h.scans.length).toBeGreaterThan(0);
  expect(h.scans[0]).toBe(300);
  expect(h.scans).toEqual(Array.from({ length: 16 }, (_, i) => (i + 1) * 300));
});

test('a burst shares one timer; a later burst schedules a new scan', () => {
  const h = harness();
  h.mutate();
  h.advance(100);
  h.mutate();
  h.advance(299);
  expect(h.scans).toEqual([]);
  h.advance(300);
  expect(h.scans).toEqual([300]);
  h.advance(1000);
  expect(h.scans).toEqual([300]);
  h.mutate();
  h.advance(1300);
  expect(h.scans).toEqual([300, 1300]);
});
