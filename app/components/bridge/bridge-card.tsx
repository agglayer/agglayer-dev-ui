'use client';

import { useMemo, useState } from 'react';
import { ArrowDownUp } from 'lucide-react';
import type { Hex } from 'viem';
import { Card } from '@/app/components/ui/card';
import { type DropdownOption } from '@/app/components/ui/dropdown';
import { TokenSelector } from '@/app/components/bridge/token-selector';
import { DestinationAddressModal } from '@/app/components/bridge/destination-address-modal';
import { BridgeFromSection } from '@/app/components/bridge/bridge-from-section';
import { BridgeToSection } from '@/app/components/bridge/bridge-to-section';
import { useTokens } from '@/app/context/token';
import { useTokenBalance } from '@/app/hooks/useTokenBalance';
import { useWallet } from '@/app/context/wallet';
import { DEFAULT_FROM_CHAIN_ID, DEFAULT_TO_CHAIN_ID, SUPPORTED_CHAINS, getChainById } from '@/app/constants/chains';
import { normalize } from '@/app/utils/format';
import type { Token } from '@/app/types/token';
import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';

const createChainOptions = (excludeChainId?: number): DropdownOption[] => {
  return SUPPORTED_CHAINS.filter((chain) => chain.id !== excludeChainId).map((chain) => ({
    value: chain.id.toString(),
    label: chain.name,
    icon: <BadgeImageFallback src={chain.icon} size="sm" />,
  }));
};

export const BridgeCard = () => {
  const { listTokens } = useTokens();
  const { address, status, connect } = useWallet();

  const [fromChainId, setFromChainId] = useState<number>(DEFAULT_FROM_CHAIN_ID);
  const [toChainId, setToChainId] = useState<number>(
    DEFAULT_TO_CHAIN_ID === DEFAULT_FROM_CHAIN_ID
      ? (SUPPORTED_CHAINS[1]?.id ?? DEFAULT_FROM_CHAIN_ID)
      : DEFAULT_TO_CHAIN_ID,
  );
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | undefined>();
  const [amount, setAmount] = useState('');
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [destinationModalOpen, setDestinationModalOpen] = useState(false);
  const [destinationAddress, setDestinationAddress] = useState('');

  const fromTokens = useMemo(() => listTokens(fromChainId), [fromChainId, listTokens]);

  const selectedToken: Token | undefined = useMemo(() => {
    if (!selectedTokenAddress) return fromTokens[0];
    return fromTokens.find((token) => normalize(token.address) === normalize(selectedTokenAddress)) ?? fromTokens[0];
  }, [fromTokens, selectedTokenAddress]);

  const fromChain = getChainById(fromChainId);
  const toChain = getChainById(toChainId);

  const { rawBalance, isLoading: balancesLoading } = useTokenBalance({
    token: selectedToken,
    userAddress: address as Hex | undefined,
    enabled: status === 'connected' && Boolean(selectedToken),
  });

  const fromChainOptions = useMemo(() => createChainOptions(), []);

  const toChainOptions = useMemo(() => createChainOptions(fromChainId), [fromChainId]);

  const hasDestinationAddress = destinationAddress.length > 0;

  const handleSelectFromChain = (chainId: number) => {
    if (chainId === toChainId) {
      setToChainId(fromChainId);
    }
    setFromChainId(chainId);
  };

  const handleSelectToChain = (chainId: number) => {
    if (chainId === fromChainId) {
      setFromChainId(toChainId);
    }
    setToChainId(chainId);
  };

  const swapChains = () => {
    setFromChainId(toChainId);
    setToChainId(fromChainId);
    setSelectedTokenAddress(undefined);
    setAmount('');
  };

  const handleSetDestinationAddress = (address: string) => {
    setDestinationAddress(address);
    setDestinationModalOpen(false);
  };

  const handleClearDestinationAddress = () => {
    setDestinationAddress('');
  };

  const actionLabel = status === 'connected' ? 'Bridge' : 'Connect wallet to bridge';

  const handleBridgeClick = () => {
    if (status !== 'connected') {
      connect();
    } else {
      console.log('bridge');
    }
  };

  return (
    <>
      <Card title="Bridge" className="max-w-5xl mx-auto space-y-3">
        <BridgeFromSection
          chainOptions={fromChainOptions}
          selectedChainId={fromChainId}
          onSelectChain={handleSelectFromChain}
          amount={amount}
          onAmountChange={setAmount}
          rawBalance={rawBalance}
          balancesLoading={balancesLoading}
          selectedToken={selectedToken}
          onOpenTokenSelector={() => setTokenModalOpen(true)}
        />

        <div className="flex justify-center">
          <button
            type="button"
            onClick={swapChains}
            className="rounded-full border border-border bg-surface p-3 hover:bg-surface-muted cursor-pointer shadow-xs transition-colors"
            aria-label="Swap chains"
          >
            <ArrowDownUp size={18} />
          </button>
        </div>

        <BridgeToSection
          chainOptions={toChainOptions}
          selectedChainId={toChainId}
          selectedChainName={toChain?.name}
          onSelectChain={handleSelectToChain}
          destinationAddress={destinationAddress}
          onOpenDestinationModal={() => setDestinationModalOpen(true)}
          onClearDestinationAddress={handleClearDestinationAddress}
        />

        <div className="pt-2">
          <button
            type="button"
            onClick={handleBridgeClick}
            className="w-full rounded-xl bg-primary text-white py-3 font-semibold shadow-xs hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed transition cursor-pointer"
          >
            {actionLabel}
          </button>
        </div>
      </Card>

      <TokenSelector
        open={tokenModalOpen}
        onClose={() => setTokenModalOpen(false)}
        selectedToken={selectedToken}
        onSelect={(token) => setSelectedTokenAddress(token.address)}
        chainId={fromChainId}
        chainName={fromChain?.name}
      />

      {destinationModalOpen && !hasDestinationAddress && (
        <DestinationAddressModal
          open={destinationModalOpen}
          onClose={() => setDestinationModalOpen(false)}
          onChangeAddress={handleSetDestinationAddress}
        />
      )}
    </>
  );
};
