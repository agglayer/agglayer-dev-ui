'use client';

import type { ClaimStep, Transaction } from '@/app/types/transaction';

import { CopyText } from '@/app/components/copyText';
import { TransactionETA } from '@/app/components/transactions/transactionEta';
import { TransactionStatusBadge } from '@/app/components/transactions/transactionStatusBadge';
import { BadgeImageFallback } from '@/app/components/ui/badgeImageFallback';
import { Button } from '@/app/components/ui/button';
import { useAppMode } from '@/app/context/appMode';
import { useTokens } from '@/app/context/token';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';
import { shortenAddress } from '@/app/utils/address';
import { getChainByNetworkId } from '@/app/utils/chains';
import { cn } from '@/app/utils/common';
import { getTokenLogoBySymbol } from '@/app/utils/tokens';
import { formatTransactionAmount, isNativeToken } from '@/app/utils/transaction';
import { ArrowRight, ExternalLink, Loader2 } from 'lucide-react';

interface TransactionListItemProps {
  transaction: Transaction;
  onClaim?: (transaction: Transaction) => void;
  onSelect?: (transaction: Transaction) => void;
  claimStep?: ClaimStep;
  isAnyClaiming?: boolean;
}

export const TransactionListItem = ({
  transaction,
  onClaim,
  onSelect,
  claimStep,
  isAnyClaiming
}: TransactionListItemProps) => {
  const { chains } = useAppMode();
  const sourceChain = getChainByNetworkId(chains, transaction.sourceNetwork);
  const destChain = getChainByNetworkId(chains, transaction.destinationNetwork);
  const isClaimable = transaction.status === 'READY_TO_CLAIM';
  const isPending = transaction.status === 'BRIDGED' || transaction.status === 'LEAF_INCLUDED';

  const isNative = isNativeToken(transaction.originTokenAddress);

  // Get the origin chain to map networkId to chainId
  const originChain = getChainByNetworkId(chains, transaction.originTokenNetwork);

  // Look up token in the local token list first
  const { getToken } = useTokens();
  const localToken = originChain
    ? getToken(originChain.id, transaction.originTokenAddress)
    : undefined;

  // Only fetch from API if not found locally and not native
  const { data: tokenMetadata } = useTokenMetadata({
    chainId: originChain?.id || 0,
    tokenAddress: transaction.originTokenAddress,
    enabled: !isNative && !localToken && Boolean(transaction.originTokenAddress && originChain)
  });

  // Priority: native currency > local token > API metadata > fallbacks
  const decimals = isNative
    ? (originChain?.nativeCurrency?.decimals ?? 18)
    : (localToken?.decimals ?? tokenMetadata?.decimals ?? 18);
  const tokenSymbol = isNative
    ? originChain?.nativeCurrency?.symbol || 'ETH'
    : localToken?.symbol || tokenMetadata?.symbol || '';
  const tokenLogo = isNative
    ? originChain?.nativeCurrency?.logoURI || originChain?.icon
    : localToken?.logoURI || tokenMetadata?.logoURI || getTokenLogoBySymbol(tokenSymbol);

  const formattedAmount = formatTransactionAmount(transaction.amount, decimals);

  return (
    <div
      onClick={() => onSelect?.(transaction)}
      data-test-id={`transaction-row-${transaction.transactionHash}`}
      className={cn(
        'rounded-2xl border border-border bg-surface shadow-sm transition hover:border-blue hover:shadow-md cursor-pointer'
      )}
    >
      <div className="p-3 space-y-2">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-sm text-black">
            {sourceChain && <span className="font-medium">{sourceChain.name}</span>}
            <ArrowRight size={18} className="text-grey" />
            {destChain && <span className="font-medium">{destChain.name}</span>}
          </div>
          <div className="flex justify-end sm:justify-start">
            <TransactionStatusBadge status={transaction.status} className="text-xs sm:text-sm" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {tokenLogo && (
              <BadgeImageFallback src={tokenLogo} size="md" fallbackText={tokenSymbol} />
            )}
            <span className="text-2xl font-bold text-black">
              {formattedAmount} {tokenSymbol}
            </span>
          </div>
        </div>
        <div className="flex flex-col md:flex-row items-center gap-2">
          <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2 text-sm text-grey w-full md:w-1/2">
            <div className="flex items-center gap-1">
              <span className="uppercase font-medium text-grey">Receiver:</span>
              <span className="font-mono text-black">
                {shortenAddress(transaction.receiverAddress, 6)}
              </span>
            </div>
            <div className="flex items-center">
              <CopyText
                textToCopy={transaction.receiverAddress}
                buttonClassName="rounded p-1 hover:bg-surface"
                iconClassName="size-3.5 text-grey"
              />
              {destChain?.explorer && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    window.open(
                      `${destChain.explorer}/address/${transaction.receiverAddress}`,
                      '_blank'
                    );
                  }}
                  className="rounded p-1 hover:bg-surface cursor-pointer"
                >
                  <ExternalLink size={14} className="text-grey" />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2 text-sm text-grey w-full md:w-1/2">
            <div className="flex items-center gap-1">
              <span className="uppercase font-medium text-grey">Bridge tx:</span>
              <span className="font-mono text-black">
                {shortenAddress(transaction.transactionHash, 6)}
              </span>
            </div>
            <div className="flex items-center">
              <CopyText
                textToCopy={transaction.transactionHash}
                buttonClassName="rounded p-1 hover:bg-surface"
                iconClassName="size-3.5 text-grey"
              />
              {sourceChain?.explorer && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    window.open(
                      `${sourceChain.explorer}/tx/${transaction.transactionHash}`,
                      '_blank'
                    );
                  }}
                  className="rounded p-1 hover:bg-surface cursor-pointer"
                >
                  <ExternalLink size={14} className="text-grey" />
                </button>
              )}
            </div>
          </div>
        </div>
        {isPending && sourceChain?.eta && (
          <TransactionETA timestamp={transaction.timestamp} etaMinutes={sourceChain.eta} />
        )}
        {isClaimable && (
          <Button
            onClick={(event) => {
              event.stopPropagation();
              onClaim?.(transaction);
            }}
            size="md"
            className="w-full"
            disabled={isAnyClaiming}
          >
            {claimStep === 'claiming' ? (
              <>
                <Loader2 className="animate-spin size-4 mr-2" />
                Claiming...
              </>
            ) : (
              'Claim tokens'
            )}
          </Button>
        )}
      </div>
    </div>
  );
};
