import type { ActivityResult } from '@/app/services/activity';
import type { Transaction } from '@/app/types/transaction';

import { describe, expect, it, vi } from 'vitest';

import { hasMorePages, isSamePageOne, loadActivityPages } from './activityPages';

const tx = (id: number) => ({ hubUID: `0xtx${id}:${id}` }) as Transaction;
const result = (ids: number[], count: number): ActivityResult => ({
  transactions: ids.map(tx),
  count,
  warnings: []
});

describe('isSamePageOne', () => {
  const previous = [tx(3), tx(2)];

  it('is true when the same bridges come back in the same order with the same total', () => {
    expect(isSamePageOne({ previous, previousCount: 3, current: result([3, 2], 3) })).toBe(true);
  });

  it('is false when the total changed', () => {
    expect(isSamePageOne({ previous, previousCount: 3, current: result([3, 2], 4) })).toBe(false);
  });

  it('is false when the total matches but a bridge differs', () => {
    expect(isSamePageOne({ previous, previousCount: 3, current: result([4, 2], 3) })).toBe(false);
  });

  it('is false when the order differs', () => {
    expect(isSamePageOne({ previous, previousCount: 3, current: result([2, 3], 3) })).toBe(false);
  });
});

describe('hasMorePages', () => {
  it('is true until the loaded pages cover the count', () => {
    expect(hasMorePages({ loadedPages: 1, pageSize: 20, count: 21 })).toBe(true);
    expect(hasMorePages({ loadedPages: 2, pageSize: 20, count: 40 })).toBe(false);
    expect(hasMorePages({ loadedPages: 1, pageSize: 20, count: 0 })).toBe(false);
  });
});

describe('loadActivityPages', () => {
  it('loads just page 1 on a first load', async () => {
    const fetchPage = vi.fn().mockResolvedValue(result([3, 2], 3));

    const data = await loadActivityPages({
      previous: undefined,
      targetPageCount: 1,
      pageSize: 2,
      fetchPage
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(data.pages.map((page) => page.length)).toEqual([2]);
    expect(data.count).toBe(3);
  });

  it('does not request a page past the last one', async () => {
    const fetchPage = vi.fn().mockResolvedValue(result([2, 1], 2));

    const data = await loadActivityPages({
      previous: undefined,
      targetPageCount: 3,
      pageSize: 2,
      fetchPage
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(data.pages).toHaveLength(1);
  });

  it('swaps in the fresh page 1 but keeps the other loaded pages when page 1 is unchanged', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(result([5, 4], 5));
    const previous = {
      pages: [
        [tx(5), tx(4)],
        [tx(3), tx(2)]
      ],
      count: 5,
      warnings: []
    };

    const data = await loadActivityPages({
      previous,
      targetPageCount: 2,
      pageSize: 2,
      fetchPage
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(data.pages[1]).toEqual(previous.pages[1]);
  });

  it('drops a row that shifted onto the next page and was returned twice', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(result([6, 5], 6))
      .mockResolvedValueOnce(result([5, 4], 6));
    const previous = { pages: [[tx(5), tx(4)]], count: 5, warnings: [] };

    const data = await loadActivityPages({
      previous,
      targetPageCount: 2,
      pageSize: 2,
      fetchPage
    });

    expect(data.pages.map((page) => page.map((row) => row.hubUID))).toEqual([
      ['0xtx6:6', '0xtx5:5'],
      ['0xtx4:4']
    ]);
  });
});
