import { describe, expect, it } from 'vitest';

import {
  CardUsageClassifierAggregate,
  CardUsageClassifierCard,
  classifyCardUsage,
  popularCountThreshold,
} from './card-usage-classifier';

// Frozen clock: every timestamp below is derived from this instant.
const NOW = '2026-09-30T00:00:00.000Z';
const WINDOW_START = '2026-08-31T00:00:00.000Z';
const OLD = '2026-08-21T00:00:00.000Z'; // 40 days ago: fully observed
const YOUNG = '2026-09-20T00:00:00.000Z'; // 10 days ago: insufficient coverage
const EXACTLY_30_DAYS_AGO = '2026-08-31T00:00:00.000Z';
const JUST_UNDER_30_DAYS_AGO = '2026-08-31T00:00:00.001Z';

function card(
  cardType: CardUsageClassifierCard['cardType'],
  cardId: string,
  createdAt: string = OLD,
): CardUsageClassifierCard {
  return { cardType, cardId, createdAt };
}

function usage(
  cardType: CardUsageClassifierAggregate['cardType'],
  cardId: string,
  count: number,
  lastUsedAt: string | null = '2026-09-15T12:00:00.000Z',
): CardUsageClassifierAggregate {
  return { cardType, cardId, count, lastUsedAt: count > 0 ? lastUsedAt : null };
}

function classify(
  cards: CardUsageClassifierCard[],
  usageRows: CardUsageClassifierAggregate[] = [],
  observationStarts: Record<string, string | null> = {
    service: OLD,
    credential: OLD,
    playbook: OLD,
  },
) {
  return classifyCardUsage({
    now: NOW,
    windowStart: WINDOW_START,
    windowEnd: NOW,
    cards,
    usage: usageRows,
    // @ts-expect-error test helper keyed by plain strings
    observationStarts,
  });
}

function categoriesOf(
  rows: ReturnType<typeof classifyCardUsage>,
): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [`${row.cardType}:${row.cardId}`, row.category]));
}

describe('popularCountThreshold', () => {
  it('returns null for an empty cohort', () => {
    expect(popularCountThreshold([])).toBeNull();
  });

  it('uses nearest-rank so a single card sets its own cutoff', () => {
    expect(popularCountThreshold([5])).toBe(5);
    expect(popularCountThreshold([0])).toBe(0);
  });

  it('picks the rank cutoff deterministically', () => {
    // n=10 -> rank=ceil(8)=8 -> 8th smallest of [0,0,0,0,0,1,2,5,10,10].
    expect(popularCountThreshold([10, 10, 5, 2, 1, 0, 0, 0, 0, 0])).toBe(5);
  });
});

describe('classifyCardUsage (NOT-293)', () => {
  it('classifies popular/used/unused with ties at the cutoff identical', () => {
    const cards = [
      'svc-a',
      'svc-b',
      'svc-c',
      'svc-d',
      'svc-e',
      'svc-f',
      'svc-g',
      'svc-h',
      'svc-i',
      'svc-j',
    ].map((cardId) => card('service', cardId));
    const usageRows = [
      usage('service', 'svc-a', 10),
      usage('service', 'svc-b', 10),
      usage('service', 'svc-c', 5),
      usage('service', 'svc-d', 2),
      usage('service', 'svc-e', 1),
    ];
    const rows = classify(cards, usageRows);

    // Threshold is 5: the tied 10s and the 5 classify identically.
    expect(categoriesOf(rows)).toEqual({
      'service:svc-a': 'popular',
      'service:svc-b': 'popular',
      'service:svc-c': 'popular',
      'service:svc-d': 'used',
      'service:svc-e': 'used',
      'service:svc-f': 'unused',
      'service:svc-g': 'unused',
      'service:svc-h': 'unused',
      'service:svc-i': 'unused',
      'service:svc-j': 'unused',
    });
    expect(rows.find((row) => row.cardId === 'svc-a')).toMatchObject({
      usageCount: 10,
      lastUsedAt: '2026-09-15T12:00:00.000Z',
      observedSince: OLD,
      windowStart: WINDOW_START,
      windowEnd: NOW,
    });
    expect(rows.find((row) => row.cardId === 'svc-f')).toMatchObject({
      usageCount: 0,
      lastUsedAt: null,
    });
  });

  it('keeps the minimum count floor of 3 even at the percentile cutoff', () => {
    const rows = classify(
      [card('service', 'svc-a'), card('service', 'svc-b'), card('service', 'svc-c')],
      [usage('service', 'svc-a', 2), usage('service', 'svc-b', 1)],
    );
    // Nearest-rank threshold is 2, but 2 < 3 so nothing is Popular.
    expect(categoriesOf(rows)).toEqual({
      'service:svc-a': 'used',
      'service:svc-b': 'used',
      'service:svc-c': 'unused',
    });
  });

  it('calculates popularity separately for each card type', () => {
    const rows = classify(
      [card('service', 'svc-huge'), card('service', 'svc-mid'), card('playbook', 'pb-modest')],
      [
        usage('service', 'svc-huge', 100),
        usage('service', 'svc-mid', 90),
        usage('playbook', 'pb-modest', 2),
      ],
    );
    // Service cohort [100, 90]: threshold 100, so 90 stays Used.
    // Playbook cohort [2]: threshold 2, but the floor of 3 keeps it Used.
    expect(categoriesOf(rows)).toEqual({
      'service:svc-huge': 'popular',
      'service:svc-mid': 'used',
      'playbook:pb-modest': 'used',
    });
  });

  it('prefers Popular over New for a young but heavily used card', () => {
    const rows = classify(
      [card('service', 'svc-new-hot', YOUNG), card('service', 'svc-old-quiet')],
      [usage('service', 'svc-new-hot', 50)],
    );
    expect(categoriesOf(rows)).toEqual({
      'service:svc-new-hot': 'popular',
      'service:svc-old-quiet': 'unused',
    });
  });

  it('marks cards New when the card or its type lacks 30 days of coverage', () => {
    const rows = classify(
      [
        card('service', 'svc-young-card', YOUNG),
        card('service', 'svc-old-card'),
        card('credential', 'cred-old-card'),
      ],
      [],
      { service: OLD, credential: YOUNG, playbook: OLD },
    );
    expect(categoriesOf(rows)).toEqual({
      'service:svc-young-card': 'new',
      'service:svc-old-card': 'unused',
      'credential:cred-old-card': 'new',
    });
  });

  it('treats a null observation start as insufficient coverage, never Unused', () => {
    const rows = classify([card('playbook', 'pb-legacy')], [], {
      service: OLD,
      credential: OLD,
      playbook: null,
    });
    expect(categoriesOf(rows)).toEqual({ 'playbook:pb-legacy': 'new' });
    expect(rows[0].observedSince).toBeNull();
  });

  it('treats exactly 30 days of coverage as fully observed, a millisecond less as New', () => {
    const rows = classify(
      [
        card('service', 'svc-exact', EXACTLY_30_DAYS_AGO),
        card('credential', 'cred-almost', OLD),
        card('playbook', 'pb-exact'),
      ],
      [],
      {
        service: OLD,
        credential: JUST_UNDER_30_DAYS_AGO,
        playbook: EXACTLY_30_DAYS_AGO,
      },
    );
    expect(categoriesOf(rows)).toEqual({
      'service:svc-exact': 'unused',
      'credential:cred-almost': 'new',
      'playbook:pb-exact': 'unused',
    });
  });

  it('marks a fully observed one-use card Used and a zero-use card Unused', () => {
    const rows = classify([card('credential', 'cred-once'), card('credential', 'cred-never')], [
      usage('credential', 'cred-once', 1, '2026-09-01T00:00:00.000Z'),
    ]);
    expect(categoriesOf(rows)).toEqual({
      'credential:cred-once': 'used',
      'credential:cred-never': 'unused',
    });
  });

  it('marks a fully observed one-card cohort Popular when it meets the floor', () => {
    const rows = classify([card('playbook', 'pb-only')], [usage('playbook', 'pb-only', 4)]);
    expect(categoriesOf(rows)).toEqual({ 'playbook:pb-only': 'popular' });
  });

  it('returns no rows for empty cohorts and ignores deleted historical card ids', () => {
    const rows = classify([card('service', 'svc-keep')], [
      usage('service', 'svc-keep', 1),
      usage('service', 'svc-deleted', 99),
      usage('playbook', 'pb-deleted', 99),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cardType: 'service',
      cardId: 'svc-keep',
      category: 'used',
      usageCount: 1,
    });
  });

  it('returns an empty list when the collection is empty', () => {
    expect(classify([])).toEqual([]);
  });

  it('sorts rows by card type then card id regardless of input order', () => {
    const rows = classify(
      [card('playbook', 'pb-b'), card('service', 'svc-a'), card('credential', 'cred-c')],
      [],
    );
    expect(rows.map((row) => `${row.cardType}:${row.cardId}`)).toEqual([
      'credential:cred-c',
      'playbook:pb-b',
      'service:svc-a',
    ]);
  });
});
