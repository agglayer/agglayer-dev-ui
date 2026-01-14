'use client';

import { useMemo } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Modal } from '@/app/components/ui/modal';
import { CopyText } from '@/app/components/copyText';
import { useTokens } from '@/app/context/token';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';
import type { ClaimStep, Transaction } from '@/app/types/transaction';
import { shortenAddress } from '@/app/utils/address';
import { formatTransactionAmount, isNativeToken } from '@/app/utils/transaction';
import { getTokenLogoBySymbol } from '@/app/utils/tokens';
import { Alert } from '@/app/components/ui/alert';
import { Button } from '@/app/components/ui/button';
import { formatDateTime } from '@/app/utils/date';
import { useAppMode } from '@/app/context/app-mode';
import { getChainByNetworkId } from '@/app/utils/chains';
import { TxDetailsHeader } from '@/app/components/transactions/transactions-details-modal/header';


interface TransactionDetailsModalProps {
  open: boolean;
  onClose: () => void;
  transaction: Transaction | null;
  isDifferentAddress?: boolean;
  onClaim?: (transaction: Transaction) => void;
  claimStep?: ClaimStep;
  isAnyClaiming?: boolean;
}

export const TransactionDetailsModal = ({
  open,
  onClose,
  transaction,
  isDifferentAddress,
  onClaim,
  claimStep,
  isAnyClaiming,
}: TransactionDetailsModalProps) => {
  const tx = transaction;
  const { getToken } = useTokens();
  const { chains } = useAppMode();

  const sourceChain = tx ? getChainByNetworkId(chains, tx.sourceNetwork) : undefined;
  const destChain = tx ? getChainByNetworkId(chains, tx.destinationNetwork) : undefined;
  const originChain = tx ? getChainByNetworkId(chains, tx.originTokenNetwork) : undefined;

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

  if (!tx) return null;

  const isClaimable = tx.status === 'READY_TO_CLAIM';

  return (
    <Modal open={open} onClose={onClose} title="Transaction Details" contentClassName="space-y-6">
      <div className="space-y-4">
        <TxDetailsHeader
          sourceChain={sourceChain ? { name: sourceChain.name, icon: sourceChain.icon } : undefined}
          destChain={destChain ? { name: destChain.name, icon: destChain.icon } : undefined}
          tokenLogo={tokenLogo}
          tokenSymbol={tokenSymbol}
          formattedAmount={`${formattedAmount}`}
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between px-3 py-2 text-sm border-border border-b">
            <span className="text-grey font-medium">Date &amp; Time</span>
            <span className="font-semibold text-black">{formatDateTime(tx.timestamp)}</span>
          </div>

          <div className="flex items-center justify-between px-3 py-2 text-sm border-border border-b">
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

          <div className="flex items-center justify-between px-3 py-2 text-sm border-border border-b">
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

        {isDifferentAddress && (
          <Alert
            title="Different receive address"
            message={`Funds will arrive at ${shortenAddress(tx.receiverAddress, 6)}, which differs from your connected wallet.`}
            type="warning"
          />
        )}

        {isClaimable && (
          <Button
            disabled={isAnyClaiming}
            onClick={() => {
              onClaim?.(tx);
            }}
            size="md"
            className="w-full"
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
    </Modal>
  );
};
