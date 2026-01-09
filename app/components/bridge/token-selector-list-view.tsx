'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { TextInput } from '@/app/components/ui/text-input';
import { formatTokenBalance, getTokenLogoBySymbol } from '@/app/utils/tokens';
import { normalize } from '@/app/utils/format';
import { getChainById } from '@/app/constants/chains';
import type { BalanceIndex, Token } from '@/app/types/token';
import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import { cn } from '@/app/utils/common';

interface TokenSelectorListViewProps {
  tokens: Token[];
  selectedToken?: Token;
  balances?: BalanceIndex;
  chainName?: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (token: Token) => void;
  onManageTokens: () => void;
}

export const TokenSelectorListView = ({
  tokens,
  selectedToken,
  balances,
  chainName,
  search,
  onSearchChange,
  onSelect,
  onManageTokens,
}: TokenSelectorListViewProps) => {
  const filteredTokens = useMemo(() => {
    if (!search) return tokens;
    const term = search.toLowerCase();
    return tokens.filter((token) => `${token.symbol} ${token.name} ${token.address}`.toLowerCase().includes(term));
  }, [search, tokens]);

  return (
    <div className="relative pb-14 space-y-3">
      <TextInput
        value={search}
        onChange={onSearchChange}
        placeholder={`Search ${chainName ? `${chainName} ` : ''}by token name or address`}
        isSearch
        className="w-full"
      />

      <div className="space-y-2">
        {filteredTokens.map((token) => {
          const isSelected =
            selectedToken &&
            selectedToken.chainId === token.chainId &&
            normalize(selectedToken.address) === normalize(token.address);
          const balance = formatTokenBalance(token, balances);
          const chain = getChainById(token.chainId);

          return (
            <button
              key={`${token.chainId}-${token.address}`}
              type="button"
              onClick={() => onSelect(token)}
              className="w-full cursor-pointer"
            >
              <div
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 transition-colors text-left',
                  isSelected
                    ? 'border-blue bg-blue-subtle shadow-xs'
                    : 'border-border hover:border-blue/50 hover:bg-surface-muted',
                )}
                aria-pressed={isSelected}
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
                    <span className="rounded-full bg-blue-light text-blue text-xs px-2 py-0.5 font-semibold">
                      Imported
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-sm text-muted">
                  <span>{balance}</span>
                </div>
              </div>
            </button>
          );
        })}

        {filteredTokens.length === 0 && (
          <div className="rounded-xl border border-border px-3 py-4 text-sm text-grey">
            No tokens match your search.
          </div>
        )}
      </div>

      <div className="absolute bottom-2 right-2">
        <button
          type="button"
          onClick={onManageTokens}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm font-semibold text-blue hover:border-blue hover:bg-blue-subtle transition-colors cursor-pointer shadow-xs"
        >
          <Plus size={16} className="shrink-0" />
          <span>Manage tokens</span>
        </button>
      </div>
    </div>
  );
};
