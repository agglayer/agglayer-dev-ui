'use client';

import type { ClaimStep, Transaction } from '@/app/types/transaction';

import { TransactionListItem } from '@/app/components/transactions/transactionListItem';
import { Button } from '@/app/components/ui/button';
import { groupTransactionsByDate } from '@/app/utils/date';
import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';

interface TransactionListProps {
  transactions: Transaction[];
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  loadMoreError?: Error | null;
  onLoadMore?: () => void;
  onClaim?: (transaction: Transaction) => void;
  onSelect?: (transaction: Transaction) => void;
  claimingTxId?: string;
  claimStep?: ClaimStep;
  isAnyClaiming?: boolean;
  // hubUIDs whose claim just succeeded and are awaiting confirmation from
  // the next activity poll -- see transactionsView.tsx's
  // pendingClaimConfirmationIds.
  pendingClaimConfirmationIds?: Set<string>;
}

export const TransactionList = ({
  transactions,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  loadMoreError,
  onLoadMore,
  onClaim,
  onSelect,
  claimingTxId,
  claimStep,
  isAnyClaiming,
  pendingClaimConfirmationIds
}: TransactionListProps) => {
  const groupedTransactions = useMemo(() => groupTransactionsByDate(transactions), [transactions]);

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
    <div className="space-y-6 max-h-[70vh] overflow-auto">
      {Object.entries(groupedTransactions).map(([date, txs]) => (
        <div key={date} className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-grey">{date}</h3>
          <div className="space-y-2">
            {txs.map((tx) => (
              <TransactionListItem
                key={tx.hubUID}
                transaction={tx}
                onClaim={onClaim}
                onSelect={onSelect}
                claimStep={tx.hubUID === claimingTxId ? claimStep : undefined}
                isAnyClaiming={isAnyClaiming}
                isPendingClaimConfirmation={pendingClaimConfirmationIds?.has(tx.hubUID) ?? false}
              />
            ))}
          </div>
        </div>
      ))}

      {hasNextPage && (
        <div className="flex flex-col items-center gap-2 py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
            data-test-id="transactions-load-more"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Loading more transactions...
              </>
            ) : (
              'Load more'
            )}
          </Button>
          {loadMoreError && (
            <p className="text-sm text-orange" data-test-id="transactions-load-more-error">
              Couldn&apos;t load more transactions. Please try again.
            </p>
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
