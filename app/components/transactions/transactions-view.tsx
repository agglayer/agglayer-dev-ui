'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plug, RotateCw } from 'lucide-react';
import { Card } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { TransactionFilters } from '@/app/components/transactions/transaction-filters';
import { TransactionList } from '@/app/components/transactions/transaction-list';
import { ClaimResultModal } from '@/app/components/transactions/claim-result-modal';
import { TOTAL_REFETCH_TIME, useTransactions } from '@/app/hooks/useTransactions';
import { useClaimExecution } from '@/app/hooks/useClaimExecution';
import { useEnforceCorrectChain } from '@/app/hooks/useEnforceCorrectChain';
import { useWallet } from '@/app/context/wallet';
import { useAppMode } from '@/app/context/app-mode';
import { useRefetch } from '@/app/context/refetch';
import type { TransactionStatus, Transaction } from '@/app/types/transaction';
import { getTransactionInitialStatus } from '@/app/components/transactions/intialStatus';
import { TransactionDetailsModal } from '@/app/components/transactions/transactions-details-modal/transaction-details-modal';
import { getChainById, getChainByNetworkId } from '@/app/utils/chains';
import { cn } from '@/app/utils/common';

export const TransactionsView = () => {
  const { address, status, chainId, connect } = useWallet();
  const { defaultFromChainId, chains, bridgeAddress } = useAppMode();
  const { aggressiveRefetch, triggerAggressiveRefetch, clearAggressiveRefetch } = useRefetch();
  const queryClient = useQueryClient();
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

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error, refetch, isRefetching } =
    useTransactions({
      chainId: effectiveChainId,
      filters: queryFilters,
      enabled: isConnected,
      aggressiveRefetch,
    });

  // Auto-disable aggressive mode after burst completes
  useEffect(() => {
    if (!aggressiveRefetch) return;
    const timeout = setTimeout(clearAggressiveRefetch, TOTAL_REFETCH_TIME);
    return () => clearTimeout(timeout);
  }, [aggressiveRefetch, clearAggressiveRefetch]);

  const handleClaimComplete = useCallback(() => {
    triggerAggressiveRefetch();
    refetch();
    queryClient.invalidateQueries({ queryKey: ['ready-to-claim-count'] });
  }, [queryClient, refetch, triggerAggressiveRefetch]);

  const ensureCorrectChain = useEnforceCorrectChain();
  const claimExecution = useClaimExecution({
    bridgeAddress,
    chains,
    address: address as Hex | undefined,
    onComplete: handleClaimComplete,
  });

  const claimingTxId = claimExecution.state.transactionId;
  const isAnyClaiming = claimExecution.state.isExecuting;
  const claimStep = claimExecution.state.currentStep;
  const claimResultOpen = claimStep === 'success' || claimStep === 'error';

  const allTransactions = useMemo(() => {
    return data?.pages.flatMap((page) => page.data) ?? [];
  }, [data]);

  const totalCount = data?.pages[0]?.pagination.total ?? 0;

  const destChain = claimExecution.state.destinationChainId
    ? getChainById(chains, claimExecution.state.destinationChainId)
    : undefined;

  const handleClaim = async (transaction: Transaction) => {
    if (!address) return;
    if (transaction.status !== 'READY_TO_CLAIM') return;

    const targetChain = getChainByNetworkId(chains, transaction.destinationNetwork);
    if (!targetChain) return;
    await ensureCorrectChain(targetChain.id);

    await claimExecution.execute({
      transaction,
      destinationChainId: targetChain.id,
    });
  };

  const handleCloseClaimResult = () => {
    claimExecution.reset();
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

  const handleManualRefetch = () => {
    void refetch();
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

        <div className="flex items-center justify-between">
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
          <button
            type="button"
            aria-label="Refresh activity"
            onClick={handleManualRefetch}
            disabled={isRefetching || isLoading}
            className={cn(
              'bg-transparent text-black',
              isRefetching ? 'cursor-not-allowed text-grey' : 'hover:text-grey cursor-pointer',
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
      />
    </Card>
  );
};
