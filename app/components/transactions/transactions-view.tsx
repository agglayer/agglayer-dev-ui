'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Plug } from 'lucide-react';
import { Card } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { TransactionFilters } from '@/app/components/transactions/transaction-filters';
import { TransactionList } from '@/app/components/transactions/transaction-list';
import { useTransactions } from '@/app/hooks/useTransactions';
import { useWallet } from '@/app/context/wallet';
import { useAppMode } from '@/app/context/app-mode';
import type { TransactionStatus } from '@/app/types/transaction';
import type { Transaction } from '@/app/types/transaction';
import { getTransactionInitialStatus } from '@/app/components/transactions/intialStatus';
import { TransactionDetailsModal } from '@/app/components/transactions/transaction-details-modal';

export const TransactionsView = () => {
  const { address, status, chainId, connect } = useWallet();
  const { defaultFromChainId } = useAppMode();
  const initialStatus = getTransactionInitialStatus();
  const [filters, setFilters] = useState<{ status?: TransactionStatus; updatedSince?: number }>(() => ({
    status: initialStatus ?? undefined,
  }));
  const statusKey = (initialStatus || filters.status || 'all') as string;
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [isDifferentAddress, setIsDifferentAddress] = useState<boolean>(false);

  const queryFilters = useMemo(
    () => ({
      fromAddress: address,
      status: filters.status,
      updatedSince: filters.updatedSince,
      order: 'desc' as const,
      limit: 20,
    }),
    [address, filters],
  );

  const effectiveChainId = chainId ?? defaultFromChainId;
  const isConnected = status === 'connected' && Boolean(address);

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error, refetch } = useTransactions({
    chainId: effectiveChainId,
    filters: queryFilters,
    enabled: isConnected,
  });

  const allTransactions = useMemo(() => {
    return data?.pages.flatMap((page) => page.data) ?? [];
  }, [data]);

  const totalCount = data?.pages[0]?.pagination.total ?? 0;

  const handleClaim = (transaction: Transaction) => {
    console.log('Claiming transaction:', transaction);
    // TODO: Implement claim logic
  };

  const handleSelectTransaction = (transaction: Transaction) => {
    setSelectedTransaction(transaction);
    const walletAddr = address?.toLowerCase();
    const receiver = transaction.receiverAddress?.toLowerCase();
    setIsDifferentAddress(Boolean(walletAddr && receiver && walletAddr !== receiver));
  };

  const handleCloseModal = () => {
    setSelectedTransaction(null);
    setIsDifferentAddress(false);
  };

  return (
    <Card key={statusKey} title="Transaction History" className="space-y-6 max-w-2xl mx-auto">
      <div className="sticky top-0 z-10 space-y-3 bg-surface pb-2">
        <div className="space-y-2">
          <p className="text-base text-grey">
            This page displays your bridge transactions. In case yours isn&apos;t visible, it&apos;s likely a temporary
            issue, and your funds are safe on the chain.
          </p>
          {totalCount > 0 && (
            <p className="text-base font-semibold text-muted">
              Total transactions: <span className="text-black">{totalCount}</span>
            </p>
          )}
        </div>

        <TransactionFilters
          key={statusKey}
          initialStatus={(filters.status as TransactionStatus | undefined) ?? null}
          onFilterChange={setFilters}
          onStatusChange={(nextStatus) =>
            setFilters((prev) => ({
              ...prev,
              status: nextStatus || undefined,
            }))
          }
          onStatusClear={() =>
            setFilters((prev) => ({
              ...prev,
              status: undefined,
            }))
          }
          disabled={!isConnected}
        />
      </div>

      {!isConnected && (
        <div className="space-y-4 rounded-xl border border-border bg-surface px-6 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-grey">
            <Plug size={28} />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-black">Wallet not connected</h3>
            <p className="text-sm text-grey">Connect your wallet to view your recent transactions.</p>
          </div>
          <div className="flex justify-center">
            <Button onClick={connect} size="sm">
              Connect your wallet
            </Button>
          </div>
        </div>
      )}

      {isConnected && error && (
        <div className="space-y-4 rounded-xl border border-border bg-surface px-6 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-orange/10 text-orange">
            <AlertTriangle size={28} />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-black">Something went wrong</h3>
            <p className="text-sm text-grey">We couldn&apos;t load your transactions right now. Please try again.</p>
          </div>
          <div className="flex justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        </div>
      )}

      {isConnected && !error && (
        <TransactionList
          transactions={allTransactions}
          isLoading={isLoading}
          isFetchingNextPage={isFetchingNextPage}
          hasNextPage={hasNextPage}
          onLoadMore={() => fetchNextPage()}
          onClaim={handleClaim}
          onSelect={handleSelectTransaction}
        />
      )}

      <TransactionDetailsModal
        open={Boolean(selectedTransaction)}
        onClose={handleCloseModal}
        transaction={selectedTransaction}
        isDifferentAddress={isDifferentAddress}
        onClaim={handleClaim}
      />
    </Card>
  );
};
