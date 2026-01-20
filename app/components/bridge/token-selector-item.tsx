'use client';

import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import { cn } from '@/app/utils/common';
import { getChainById } from '@/app/utils/chains';
import { normalize } from '@/app/utils/format';
import { formatTokenBalance, getTokenLogoBySymbol } from '@/app/utils/tokens';
import { useWallet } from '@/app/context/wallet-context';
import { useTokenBalance } from '@/app/hooks/useTokenBalance';
import { useAppMode } from '@/app/context/app-mode';
import type { Token } from '@/app/types/token';

interface TokenSelectorItemProps {
  token: Token;
  selectedToken?: Token;
  onSelect: (token: Token) => void;
}

export const TokenSelectorItem = ({ token, selectedToken, onSelect }: TokenSelectorItemProps) => {
  const { address, status } = useWallet();
  const { chains } = useAppMode();
  const isConnected = status === 'connected';
  const userAddress = isConnected ? address : undefined;

  const { rawBalance, isLoading } = useTokenBalance({
    token,
    userAddress,
    enabled: isConnected,
  });

  const isSelected =
    selectedToken &&
    selectedToken.chainId === token.chainId &&
    normalize(selectedToken.address) === normalize(token.address);

  const chain = getChainById(chains, token.chainId);
  const balanceText = isLoading ? '...' : formatTokenBalance(token, rawBalance);

  return (
    <button type="button" onClick={() => onSelect(token)} className="w-full cursor-pointer" aria-pressed={isSelected}>
      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 transition-colors text-left',
          isSelected
            ? 'border-blue bg-blue-subtle shadow-xs'
            : 'border-border hover:border-blue/50 hover:bg-surface-muted',
        )}
      >
        <div className="flex items-center gap-3">
          <BadgeImageFallback
            src={token.logoURI || getTokenLogoBySymbol(token.symbol)}
            size="md"
            fallbackText={token.symbol}
          />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-black">{token.symbol}</span>
            <span className="text-xs text-grey">{token.name}</span>
          </div>
          {chain && (
            <div className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2 py-0.75 text-xs text-grey">
              <BadgeImageFallback src={chain.icon} size="xs" />
              <span>{chain.name}</span>
            </div>
          )}
          {token.isCustom && (
            <span className="rounded-full bg-blue-light text-blue text-xs px-2 py-0.5 font-semibold">Imported</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          <span>{balanceText}</span>
        </div>
      </div>
    </button>
  );
};
