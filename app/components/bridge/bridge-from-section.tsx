'use client';

import { useMemo } from 'react';
import { Dropdown, type DropdownOption } from '@/app/components/ui/dropdown';
import { AmountInput } from '@/app/components/ui/amount-input';
import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import { formatTokenBalance, getTokenLogoBySymbol, portionOfBalance } from '@/app/utils/tokens';
import type { BalanceIndex, Token } from '@/app/types/token';

interface BridgeFromSectionProps {
  chainOptions: DropdownOption[];
  selectedChainId: number;
  onSelectChain: (chainId: number) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  balanceIndex?: BalanceIndex;
  balancesLoading: boolean;
  selectedToken?: Token;
  onOpenTokenSelector: () => void;
}

export const BridgeFromSection = ({
  chainOptions,
  selectedChainId,
  onSelectChain,
  amount,
  onAmountChange,
  balanceIndex,
  balancesLoading,
  selectedToken,
  onOpenTokenSelector,
}: BridgeFromSectionProps) => {
  const balanceText = selectedToken ? formatTokenBalance(selectedToken, balanceIndex) : '0';

  const quickActions = useMemo(() => {
    if (!selectedToken) return [];
    return [
      { label: '25%', value: portionOfBalance(selectedToken, balanceIndex, 0.25) },
      { label: '50%', value: portionOfBalance(selectedToken, balanceIndex, 0.5) },
      { label: 'MAX', value: portionOfBalance(selectedToken, balanceIndex, 1) },
    ];
  }, [balanceIndex, selectedToken]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-muted">Bridge from</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px,1fr] gap-3">
        <Dropdown
          options={chainOptions}
          selectedValue={selectedChainId.toString()}
          onSelect={(option) => onSelectChain(Number(option.value))}
        />

        <AmountInput
          value={amount}
          onChange={onAmountChange}
          placeholder="0"
          balanceText={balancesLoading ? '...' : balanceText}
          tokenLabel={selectedToken?.symbol ?? 'Select token'}
          tokenIcon={
            selectedToken ? (
              <BadgeImageFallback
                variant="token"
                src={selectedToken.logoURI || getTokenLogoBySymbol(selectedToken.symbol)}
                size="sm"
                fallbackText={selectedToken.symbol}
              />
            ) : undefined
          }
          onClick={onOpenTokenSelector}
          quickActions={quickActions}
        />
      </div>
    </section>
  );
};
