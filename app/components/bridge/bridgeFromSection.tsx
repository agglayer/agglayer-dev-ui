'use client';

import { useMemo } from 'react';
import { Dropdown, type DropdownOption } from '@/app/components/ui/dropdown';
import { AmountInput } from '@/app/components/ui/amountInput';
import { BadgeImageFallback } from '@/app/components/ui/badgeImageFallback';
import { formatTokenBalance, getTokenLogoBySymbol, portionOfBalance } from '@/app/utils/tokens';
import type { Token } from '@/app/types/token';
import { normalize } from '@/app/utils/format';
import { ZERO_ADDRESS } from '@/app/types/bridge';

interface BridgeFromSectionProps {
  chainOptions: DropdownOption[];
  selectedChainId: number;
  onSelectChain: (chainId: number) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  rawBalance?: string;
  balancesLoading: boolean;
  selectedToken?: Token;
  onOpenTokenSelector: () => void;
  maxNativeAmount?: string;
}

export const BridgeFromSection = ({
  chainOptions,
  selectedChainId,
  onSelectChain,
  amount,
  onAmountChange,
  rawBalance,
  balancesLoading,
  selectedToken,
  onOpenTokenSelector,
  maxNativeAmount,
}: BridgeFromSectionProps) => {
  const balanceText = selectedToken ? formatTokenBalance(selectedToken, rawBalance) : '0';

  const quickActions = useMemo(() => {
    if (!selectedToken) return [];
    const isNativeToken = selectedToken.isNative || normalize(selectedToken.address) === normalize(ZERO_ADDRESS);
    const maxValue =
      isNativeToken && maxNativeAmount ? maxNativeAmount : portionOfBalance(selectedToken, rawBalance, 1);
    return [
      { label: '25%', value: portionOfBalance(selectedToken, rawBalance, 0.25) },
      { label: '50%', value: portionOfBalance(selectedToken, rawBalance, 0.5) },
      { label: 'MAX', value: maxValue },
    ];
  }, [rawBalance, selectedToken, maxNativeAmount]);

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
          inputTestId="bridge-amount-input"
          tokenLabel={selectedToken?.symbol ?? 'Select token'}
          tokenButtonTestId="token-selector-trigger"
          tokenIcon={
            selectedToken ? (
              <BadgeImageFallback
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
