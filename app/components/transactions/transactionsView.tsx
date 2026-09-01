'use client';

import type { TransactionStatus, Transaction } from '@/app/types/transaction';

import { ClaimResultModal } from '@/app/components/transactions/claimResultModal';
import { getTransactionInitialStatus } from '@/app/components/transactions/intialStatus';
import { TransactionDetailsModal } from '@/app/components/transactions/transactionDetailsModal/transactionDetailsModal';
import { TransactionFilters } from '@/app/components/transactions/transactionFilters';
import { TransactionList } from '@/app/components/transactions/transactionList';
import { Button } from '@/app/components/ui/button';
import { Card } from '@/app/components/ui/card';
import { useAppMode } from '@/app/context/appMode';
import { useRefetch } from '@/app/context/refetch';
import { useWallet } from '@/app/context/walletContext';
import { useClaimExecution } from '@/app/hooks/useClaimExecution';
import { useEnforceCorrectChain } from '@/app/hooks/useEnforceCorrectChain';
import { TOTAL_REFETCH_TIME, useTransactions } from '@/app/hooks/useTransactions';
import { getChainById, getChainByNetworkId } from '@/app/utils/chains';
import { cn } from '@/app/utils/common';
import { AlertTriangle, Plug, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const TransactionsView = () => {
  const { address, status, chainId, connect } = useWallet();
  const { defaultFromChainId, chains } = useAppMode();
  const { aggressiveRefetch, triggerAggressiveRefetch, clearAggressiveRefetch } = useRefetch();
  const initialStatus = getTransactionInitialStatus();
  const [filters, setFilters] = useState<{ status?: TransactionStatus; updatedSince?: number }>(
    () => ({
      status: initialStatus ?? undefined
    })
  );
  const statusKey = (initialStatus || filters.status || 'all') as string;
  // Store just the id, not the Transaction object: allTransactions gets a
  // fresh array (and fresh row objects) every poll, so looking the row up by
  // id each render is what keeps the modal's status/tracker live while
  // it's open, instead of freezing on the object captured at click time --
  // see useBridgeTracking.ts, which now reads tracking straight off
  // whatever Transaction object it's handed.
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);

  const queryFilters = useMemo(
    () => ({
      fromAddress: address,
      status: filters.status,
      updatedSince: filters.updatedSince,
      order: 'desc' as const,
      limit: 20
    }),
    [address, filters]
  );

  const effectiveChainId = chainId ?? defaultFromChainId;
  const isConnected = status === 'connected' && Boolean(address);

  const {
    transactions: allTransactions,
    totalCount,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
    refetch,
    isRefetching
  } = useTransactions({
    chainId: effectiveChainId,
    filters: queryFilters,
    enabled: isConnected,
    aggressiveRefetch
  });

  // Auto-disable aggressive mode after burst completes
  useEffect(() => {
    if (!aggressiveRefetch) return;
    const timeout = setTimeout(clearAggressiveRefetch, TOTAL_REFETCH_TIME);
    return () => clearTimeout(timeout);
  }, [aggressiveRefetch, clearAggressiveRefetch]);

  const handleClaimComplete = useCallback(() => {
    triggerAggressiveRefetch();
    // useReadyToClaimCount (header badge) shares this exact queryKey
    // (['activity', mode, chainId, address], see useTransactions/
    // useReadyToClaimCount) so refetching here also refreshes the badge --
    // no separate invalidation needed.
    void refetch();
  }, [refetch, triggerAggressiveRefetch]);

  const ensureCorrectChain = useEnforceCorrectChain();
  const claimExecution = useClaimExecution({
    chains,
    onComplete: handleClaimComplete
  });

  const claimingTxId = claimExecution.state.transactionId;
  const isAnyClaiming = claimExecution.state.isExecuting;
  const claimStep = claimExecution.state.currentStep;
  const claimResultOpen = claimStep === 'success' || claimStep === 'error';

  const destChain = claimExecution.state.destinationChainId
    ? getChainById(chains, claimExecution.state.destinationChainId)
    : undefined;

  // Looked up fresh every render (not stored as its own state) so the modal
  // reflects the latest poll -- see selectedTransactionId's comment above.
  // Note: if the tx falls out of the currently visible/filtered page (e.g.
  // it becomes CLAIMED while the status filter is "Ready to claim"), it
  // disappears from allTransactions and the modal closes, same as its row
  // would vanish from the list itself.
  const selectedTransaction = useMemo(
    () => allTransactions.find((tx) => tx.hubUID === selectedTransactionId) ?? null,
    [allTransactions, selectedTransactionId]
  );

  const isDifferentAddress = useMemo(() => {
    const walletAddr = address?.toLowerCase();
    const receiver = selectedTransaction?.receiverAddress?.toLowerCase();
    return Boolean(walletAddr && receiver && walletAddr !== receiver);
  }, [address, selectedTransaction]);

  const handleClaim = async (transaction: Transaction) => {
    if (!address) return;
    if (transaction.status !== 'READY_TO_CLAIM') return;

    const targetChain = getChainByNetworkId(chains, transaction.destinationNetwork);
    if (!targetChain) return;
    await ensureCorrectChain(targetChain.id);

    await claimExecution.execute({
      transaction,
      destinationChainId: targetChain.id
    });
  };

  const handleCloseClaimResult = () => {
    claimExecution.reset();
  };

  const handleSelectTransaction = (transaction: Transaction) => {
    setSelectedTransactionId(transaction.hubUID);
  };

  const handleCloseModal = () => {
    setSelectedTransactionId(null);
  };

  const handleManualRefetch = () => {
    void refetch();
  };

  return (
    <Card key={statusKey} title="Transaction History" className="space-y-6 max-w-2xl mx-auto">
      <div className="sticky top-0 z-10 space-y-3 bg-surface pb-2">
        <div className="space-y-2">
          <p className="text-base text-grey">
            This page displays your bridge transactions. In case yours isn&apos;t visible, it&apos;s
            likely a temporary issue, and your funds are safe on the chain.
          </p>
          {totalCount > 0 && (
            <p className="text-base font-semibold text-muted">
              Total transactions: <span className="text-black">{totalCount}</span>
            </p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <TransactionFilters
            key={statusKey}
            initialStatus={(filters.status as TransactionStatus | undefined) ?? null}
            onFilterChange={setFilters}
            onStatusChange={(nextStatus) =>
              setFilters((prev) => ({
                ...prev,
                status: nextStatus || undefined
              }))
            }
            onStatusClear={() =>
              setFilters((prev) => ({
                ...prev,
                status: undefined
              }))
            }
            disabled={!isConnected}
          />
          <button
            type="button"
            aria-label="Refresh activity"
            data-test-id="transactions-refresh"
            onClick={handleManualRefetch}
            disabled={isRefetching || isLoading}
            className={cn(
              'bg-transparent text-black',
              isRefetching ? 'cursor-not-allowed text-grey' : 'hover:text-grey cursor-pointer'
            )}
          >
            <RotateCw aria-hidden="true" className={cn('size-4', isRefetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {!isConnected && (
        <div className="space-y-4 rounded-xl border border-border bg-surface px-6 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-grey">
            <Plug size={28} />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-black">Wallet not connected</h3>
            <p className="text-sm text-grey">
              Connect your wallet to view your recent transactions.
            </p>
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
            <p className="text-sm text-grey">
              We couldn&apos;t load your transactions right now. Please try again.
            </p>
          </div>
          <div className="flex justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
          {error.message && (
            <details
              className="mx-auto w-full max-w-md text-left text-sm"
              data-test-id="activity-error-details"
            >
              <summary className="cursor-pointer text-grey hover:text-foreground">
                Technical details
              </summary>
              <div className="mt-2 space-y-1 rounded-lg bg-surface-muted p-3 text-xs text-grey">
                <p className="break-words">
                  <span className="font-semibold">Error:</span> {error.message}
                </p>
              </div>
            </details>
          )}
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
          claimingTxId={claimingTxId}
          claimStep={claimStep}
          isAnyClaiming={isAnyClaiming}
        />
      )}

      <TransactionDetailsModal
        open={Boolean(selectedTransaction)}
        onClose={handleCloseModal}
        transaction={selectedTransaction}
        isDifferentAddress={isDifferentAddress}
        onClaim={handleClaim}
        claimStep={selectedTransaction?.hubUID === claimingTxId ? claimStep : undefined}
        isAnyClaiming={isAnyClaiming}
      />

      <ClaimResultModal
        open={claimResultOpen}
        onClose={handleCloseClaimResult}
        status={claimStep === 'success' ? 'success' : claimStep === 'error' ? 'error' : null}
        claimTxHash={claimExecution.state.claimTxHash}
        explorerUrl={destChain?.explorer}
        errorMessage={claimExecution.state.error?.message}
        errorStep={claimExecution.state.error?.step}
      />
    </Card>
  );
};
