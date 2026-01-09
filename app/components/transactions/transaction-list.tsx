'use client';

import { useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { TransactionListItem } from '@/app/components/transactions/transaction-list-item';
import { useInfiniteScroll } from '@/app/hooks/useInfiniteScroll';
import { groupTransactionsByDate } from '@/app/utils/date';
import type { Transaction } from '@/app/types/transaction';

interface TransactionListProps {
  transactions: Transaction[];
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  onLoadMore?: () => void;
  onClaim?: (transaction: Transaction) => void;
}

export const TransactionList = ({
  transactions,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
  onClaim,
}: TransactionListProps) => {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const groupedTransactions = useMemo(() => groupTransactionsByDate(transactions), [transactions]);

  useInfiniteScroll({
    sentinelRef,
    onIntersect: () => {
      if (hasNextPage && !isFetchingNextPage && onLoadMore) {
        onLoadMore();
      }
    },
    enabled: Boolean(hasNextPage && !isFetchingNextPage),
    rootMargin: '100px',
    rootRef: scrollContainerRef,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-blue" />
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-6 py-12 text-center shadow-xs">
        <p className="text-lg font-semibold text-black">No transactions found</p>
        <p className="text-sm text-grey mt-1">Your bridge transactions will appear here</p>
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="space-y-6 max-h-[70vh] overflow-auto">
      {Object.entries(groupedTransactions).map(([date, txs]) => (
        <div key={date} className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-grey">{date}</h3>
          <div className="space-y-2">
            {txs.map((tx) => (
              <TransactionListItem key={tx.hubUID} transaction={tx} onClaim={onClaim} />
            ))}
          </div>
        </div>
      ))}

      {hasNextPage && (
        <div ref={sentinelRef} className="flex items-center justify-center py-4">
          {isFetchingNextPage && (
            <div className="flex items-center gap-2 text-sm text-grey">
              <Loader2 size={20} className="animate-spin" />
              <span>Loading more transactions...</span>
            </div>
          )}
        </div>
      )}

      {!hasNextPage && transactions.length > 0 && (
        <div className="text-center py-4">
          <p className="text-sm text-grey">No more transactions</p>
        </div>
      )}
    </div>
  );
};
