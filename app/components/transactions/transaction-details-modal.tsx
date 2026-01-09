'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Modal } from '@/app/components/ui/modal';
import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import { CopyText } from '@/app/components/copyText';
import { getChainByNetworkId } from '@/app/constants/chains';
import { useTokens } from '@/app/context/token';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';
import type { Transaction } from '@/app/types/transaction';
import { shortenAddress } from '@/app/utils/address';
import { formatTransactionAmount, isNativeToken, getTransactionFeesForBridgeAndClaim } from '@/app/utils/transaction';
import { getTokenLogoBySymbol } from '@/app/utils/tokens';
import { formatTokenAmount } from '@/app/utils/format';
import { formatUnits } from 'viem';
import { Alert } from '@/app/components/ui/alert';
import { Button } from '@/app/components/ui/button';
import { formatDateTime } from '@/app/utils/date';

interface TransactionDetailsModalProps {
  open: boolean;
  onClose: () => void;
  transaction: Transaction | null;
  isDifferentAddress?: boolean;
  onClaim?: (transaction: Transaction) => void;
}

type FeesState = {
  bridgeFeeWei?: bigint | null;
  claimFeeWei?: bigint | null;
  loading: boolean;
};

const formatFee = (fee: bigint | null | undefined, decimals: number, loading: boolean) => {
  if (loading) return 'Fetching...';
  if (fee === undefined) return '-';
  if (fee === null) return '0';
  return formatTokenAmount(formatUnits(fee, decimals));
};

export const TransactionDetailsModal = ({
  open,
  onClose,
  transaction,
  isDifferentAddress,
  onClaim,
}: TransactionDetailsModalProps) => {
  const tx = transaction;
  const { getToken } = useTokens();

  const sourceChain = tx ? getChainByNetworkId(tx.sourceNetwork) : undefined;
  const destChain = tx ? getChainByNetworkId(tx.destinationNetwork) : undefined;
  const originChain = tx ? getChainByNetworkId(tx.originTokenNetwork) : undefined;

  const isNative = tx ? isNativeToken(tx.originTokenAddress) : false;
  const localToken = useMemo(
    () => (tx && originChain ? getToken(originChain.id, tx.originTokenAddress) : undefined),
    [getToken, originChain, tx],
  );

  const { data: tokenMetadata } = useTokenMetadata({
    chainId: originChain?.id || 0,
    tokenAddress: tx?.originTokenAddress,
    enabled: Boolean(tx && originChain && !isNative && !localToken),
  });

  const decimals = isNative
    ? (originChain?.nativeCurrency?.decimals ?? 18)
    : (localToken?.decimals ?? tokenMetadata?.decimals ?? 18);
  const tokenSymbol = isNative
    ? originChain?.nativeCurrency?.symbol || 'ETH'
    : localToken?.symbol || tokenMetadata?.symbol || '';
  const tokenLogo = isNative
    ? originChain?.nativeCurrency?.logoURI || originChain?.icon
    : localToken?.logoURI || tokenMetadata?.logoURI || getTokenLogoBySymbol(tokenSymbol);
  const formattedAmount = tx ? formatTransactionAmount(tx.amount, decimals) : '-';

  const [fees, setFees] = useState<FeesState>({ loading: false });




  useEffect(() => {
    let cancelled = false;
    if (!open || !tx) return undefined;

    const fetchFees = async () => {
      // Defer state update to avoid synchronous setState warnings inside effects
      await Promise.resolve();
      if (cancelled) return;
      setFees((prev) => ({ ...prev, loading: true }));
      try {
        const data = await getTransactionFeesForBridgeAndClaim(tx);
        if (cancelled) return;
        setFees({ ...data, loading: false });
      } catch {
        if (cancelled) return;
        setFees({ bridgeFeeWei: null, claimFeeWei: null, loading: false });
      }
    };

    void fetchFees();

    return () => {
      cancelled = true;
    };
  }, [open, tx]);

  if (!tx) return null;

  const isClaimable = tx.status === 'READY_TO_CLAIM';

  return (
    <Modal open={open} onClose={onClose} title="Transaction Details" contentClassName="space-y-6">
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-surface-muted px-4 py-5 text-center space-y-3">
          <div className="flex items-center justify-center gap-3">
            {sourceChain && <BadgeImageFallback src={sourceChain.icon} size="md" fallbackText={sourceChain.name} />}
            <ArrowRight size={18} className="text-grey" />
            {destChain && <BadgeImageFallback src={destChain.icon} size="md" fallbackText={destChain.name} />}
          </div>
          <div className="space-y-1">
            <div className="text-3xl font-bold text-black flex items-center justify-center gap-2">
              {tokenLogo && <BadgeImageFallback src={tokenLogo} size="xl" fallbackText={tokenSymbol} />}
              <span>
                {formattedAmount} {tokenSymbol}
              </span>
            </div>
            <div className="text-sm text-grey">
              $ --
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm bg-grey-light">
            <span className="text-grey font-medium">Date &amp; Time</span>
            <span className="font-semibold text-black">{formatDateTime(tx.timestamp)}</span>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm bg-grey-light">
            <span className="text-grey font-medium">{`${sourceChain?.name ?? 'Source'} Tx. Hash`}</span>
            <div className="flex items-center gap-px">
              <span className="font-mono text-black">{shortenAddress(tx.transactionHash, 6)}</span>
              <CopyText
                textToCopy={tx.transactionHash}
                buttonClassName="rounded p-1 hover:bg-surface text-black"
                iconClassName="size-3.5 text-grey"
              />
              {sourceChain?.explorer && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    window.open(`${sourceChain.explorer}/tx/${tx.transactionHash}`, '_blank', 'noopener');
                  }}
                  className="rounded p-1 cursor-pointer hover:bg-surface"
                >
                  <ExternalLink size={14} className="text-black" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm bg-grey-light">
            <span className="text-grey font-medium">{`${destChain?.name ?? 'Destination'} Tx. Hash`}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-black">
                {tx.claimTransactionHash ? shortenAddress(tx.claimTransactionHash, 6) : '-'}
              </span>
              {tx.claimTransactionHash && (
                <>
                  <CopyText
                    textToCopy={tx.claimTransactionHash}
                    buttonClassName="rounded p-1 hover:bg-surface"
                    iconClassName="size-3.5 text-grey"
                  />
                  {destChain?.explorer && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        window.open(`${destChain.explorer}/tx/${tx.claimTransactionHash}`, '_blank', 'noopener');
                      }}
                      className="rounded p-1 hover:bg-surface"
                    >
                      <ExternalLink size={14} className="text-grey" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm bg-grey-light">
            <span className="text-grey font-medium">{`Step 1 Fee (${sourceChain?.name ?? 'Source'})`}</span>
            <div className="text-right">
              <div className="font-semibold text-black">
                {formatFee(fees.bridgeFeeWei, sourceChain?.nativeCurrency?.decimals ?? 18, fees.loading)}{' '}
                {sourceChain?.nativeCurrency?.symbol ?? 'ETH'}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm bg-grey-light">
            <span className="text-grey font-medium">{`Step 2 Fee (${destChain?.name ?? 'Destination'})`}</span>
            <div className="text-right">
              <div className="font-semibold text-black">
                {tx.claimTransactionHash
                  ? `${formatFee(fees.claimFeeWei, destChain?.nativeCurrency?.decimals ?? 18, fees.loading)} ${
                      destChain?.nativeCurrency?.symbol ?? 'ETH'
                    }`
                  : '-'}
              </div>
            </div>
          </div>
        </div>

        {isDifferentAddress && (
          <Alert
            title="Different receive address"
            message={`Funds will arrive at ${shortenAddress(tx.receiverAddress, 6)}, which differs from your connected wallet.`}
            type="warning"
          />
        )}

        {isClaimable && (
          <Button
            disabled={!isClaimable}
            onClick={() => {
              onClaim?.(tx);
            }}
            size="md"
            className="w-full"
          >
            Claim tokens
          </Button>
        )}
      </div>
    </Modal>
  );
};
