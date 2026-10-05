import type { ActivityResult } from '@/app/services/activity';
import type { Transaction } from '@/app/types/transaction';

import type { AggkitActivityWarning } from '@agglayer/sdk';

// The tracker's activity pages are newest-first but NOT a consistent
// snapshot: its background refresh can add bridges between two requests,
// shifting older ones down a page. So the pages loaded so far are only
// trusted while page 1 still reads exactly the same; as soon as it doesn't,
// every loaded page is requested again.

export interface ActivityPages {
  // One entry per loaded page, in page order.
  pages: Transaction[][];
  // Total bridges matching the filter across every page (server-side count).
  count: number;
  warnings: AggkitActivityWarning[];
}

type FetchPage = (pageNumber: number) => Promise<ActivityResult>;

// Bridge by bridge, in order, and the total too -- a matching length alone
// would miss one bridge arriving while another one leaves the filter.
export const isSamePageOne = (params: {
  previous: Transaction[];
  previousCount: number;
  current: ActivityResult;
}): boolean => {
  const { previous, previousCount, current } = params;
  return (
    previousCount === current.count &&
    previous.length === current.transactions.length &&
    previous.every((tx, index) => tx.hubUID === current.transactions[index]?.hubUID)
  );
};

export const hasMorePages = (params: {
  loadedPages: number;
  pageSize: number;
  count: number;
}): boolean => params.loadedPages * params.pageSize < params.count;

// A bridge arriving between two page requests can push one row onto the next
// page too, so the same row may be returned twice. Keep the first (newest
// page's) copy.
const dedupe = (pages: Transaction[][]): Transaction[][] => {
  const seen = new Set<string>();
  return pages.map((page) =>
    page.filter((tx) => {
      if (seen.has(tx.hubUID)) return false;
      seen.add(tx.hubUID);
      return true;
    })
  );
};

/**
 * Always requests page 1 first. If it matches what was already loaded, the
 * loaded pages are kept (page 1 swapped for the fresh copy, so its statuses
 * stay current) and only the missing pages up to `targetPageCount` are
 * requested. If it changed, pages 2..`targetPageCount` are requested again
 * too.
 */
export const loadActivityPages = async (params: {
  previous: ActivityPages | undefined;
  targetPageCount: number;
  pageSize: number;
  fetchPage: FetchPage;
}): Promise<ActivityPages> => {
  const { previous, targetPageCount, pageSize, fetchPage } = params;

  const first = await fetchPage(1);
  const [previousFirst, ...previousRest] = previous?.pages ?? [];
  const unchanged =
    previous !== undefined &&
    previousFirst !== undefined &&
    isSamePageOne({ previous: previousFirst, previousCount: previous.count, current: first });

  const pages: Transaction[][] = [first.transactions, ...(unchanged ? previousRest : [])];

  // Missing pages are requested one after the other: each next one is only
  // worth asking for if the previous one didn't already reach the end.
  while (
    pages.length < targetPageCount &&
    hasMorePages({ loadedPages: pages.length, pageSize, count: first.count })
  ) {
    const next = await fetchPage(pages.length + 1);
    pages.push(next.transactions);
  }

  return { pages: dedupe(pages), count: first.count, warnings: first.warnings };
};
