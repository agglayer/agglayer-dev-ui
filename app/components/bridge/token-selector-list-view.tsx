'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { TextInput } from '@/app/components/ui/text-input';
import type { Token } from '@/app/types/token';
import { TokenSelectorItem } from '@/app/components/bridge/token-selector-item';

interface TokenSelectorListViewProps {
  tokens: Token[];
  selectedToken?: Token;
  chainName?: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (token: Token) => void;
  onManageTokens: () => void;
}

export const TokenSelectorListView = ({
  tokens,
  selectedToken,
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
    <div className="relative pb-14 space-y-3" data-test-id="token-selector-list">
      <TextInput
        value={search}
        onChange={onSearchChange}
        placeholder={`Search ${chainName ? `${chainName} ` : ''}by token name or address`}
        isSearch
        className="w-full"
      />

      <div className="space-y-2">
        {filteredTokens.map((token) => (
          <TokenSelectorItem
            key={`${token.chainId}-${token.address}`}
            token={token}
            selectedToken={selectedToken}
            onSelect={onSelect}
          />
        ))}

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
