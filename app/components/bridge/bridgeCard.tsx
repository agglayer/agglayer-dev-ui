'use client';

import { BridgeFromSection } from '@/app/components/bridge/bridgeFromSection';
import { BridgeToSection } from '@/app/components/bridge/bridgeToSection';
import { BridgeTransactionModal } from '@/app/components/bridge/bridgeTransactionModal/bridgeTransactionModal';
import { DestinationAddressModal } from '@/app/components/bridge/destinationAddressModal';
import { EstimationInfo } from '@/app/components/bridge/estimationInfo';
import { TokenSelector } from '@/app/components/bridge/tokenSelector';
import { Alert } from '@/app/components/ui/alert';
import { BadgeImageFallback } from '@/app/components/ui/badgeImageFallback';
import { Card } from '@/app/components/ui/card';
import { useAppMode } from '@/app/context/appMode';
import { usePendingBridges } from '@/app/context/pendingBridges';
import { useWallet } from '@/app/context/walletContext';
import { useBridge } from '@/app/hooks/useBridge';
import { useBridgeExecution } from '@/app/hooks/useBridgeExecution';
import { useEnforceCorrectChain } from '@/app/hooks/useEnforceCorrectChain';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import { getBridgeCtaState } from '@/app/utils/bridge';
import { ArrowDownUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const createChainOptions = (
  chains: { id: number; name: string; icon?: string }[],
  excludeChainId?: number
) =>
  chains
    .filter((chain) => chain.id !== excludeChainId)
    .map((chain) => ({
      value: chain.id.toString(),
      label: chain.name,
      icon: <BadgeImageFallback src={chain.icon} size="sm" />
    }));

const BridgeCardContent = () => {
  const { connect } = useWallet();
  const { form, derived, actions, status, balance, gasEstimate } = useBridge();

  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [destinationModalOpen, setDestinationModalOpen] = useState(false);
  const [transactionModalOpen, setTransactionModalOpen] = useState(false);

  const ensureCorrectChain = useEnforceCorrectChain();
  const execution = useBridgeExecution({ fromChainId: form.fromChainId });
  const { addPendingBridge } = usePendingBridges();

  const fromChainOptions = useMemo(() => createChainOptions(derived.chains), [derived.chains]);
  const toChainOptions = useMemo(
    () => createChainOptions(derived.chains, form.fromChainId),
    [derived.chains, form.fromChainId]
  );

  const isLoading =
    status.isLoadingAllowance || status.isLoadingBalance || execution.state.isExecuting;
  const ctaState = getBridgeCtaState({
    isConnected: derived.isConnected,
    isLoading,
    validationError: status.validationError
  });

  const handleSetDestination = (addr: string) => {
    actions.setDestination(addr);
    setDestinationModalOpen(false);
  };

  const handleBridgeClick = useCallback(async () => {
    if (ctaState.action === 'connect') {
      connect();
      return;
    }

    if (ctaState.action !== 'bridge') return;
    if (!form.selectedToken) return;
    if (!derived.walletAddress) return;

    await ensureCorrectChain(form.fromChainId);

    setTransactionModalOpen(true);
    void execution.execute({
      toChainId: form.toChainId,
      token: form.selectedToken,
      amountWei: balance.amountWei,
      destinationAddress: form.destinationAddress.trim() || undefined,
      needsApproval: Boolean(status.needsApproval),
      isNative: derived.isNative
    });
  }, [
    ctaState.action,
    connect,
    ensureCorrectChain,
    form,
    derived,
    balance,
    status.needsApproval,
    execution
  ]);

  // Adds a local placeholder row the instant the bridge tx confirms, so
  // /transactions shows it immediately instead of looking empty until
  // aggkit's activity endpoint indexes it (RefetchContext's aggressive-
  // refetch burst still takes a few seconds -- see bridgeSuccessView.tsx /
  // useTransactions.ts). Keyed off bridgeTxHash so a re-render (or the
  // effect re-running for any other reason) never adds the same bridge
  // twice; useTransactions.ts drops this placeholder as soon as the real
  // activity feed reports the same transactionHash.
  const addedBridgeHashRef = useRef<string | undefined>(undefined);
  const { fromChain, toChain, walletAddress, isNative } = derived;
  const { selectedToken, destinationAddress } = form;
  const { amountWei } = balance;
  const { currentStep, bridgeTxHash } = execution.state;
  useEffect(() => {
    if (currentStep !== 'success' || !bridgeTxHash) return;
    if (addedBridgeHashRef.current === bridgeTxHash) return;
    if (!fromChain || !toChain || !selectedToken || !walletAddress) return;
    addedBridgeHashRef.current = bridgeTxHash;

    const recipient = destinationAddress.trim() || walletAddress;
    const nowSeconds = Math.floor(Date.now() / 1000);

    addPendingBridge({
      hubUID: `pending-${bridgeTxHash}`,
      txSender: walletAddress,
      fromAddress: walletAddress,
      receiverAddress: recipient,
      sourceNetwork: fromChain.networkId,
      destinationNetwork: toChain.networkId,
      amount: amountWei.toString(),
      status: 'PENDING',
      lastUpdatedAt: nowSeconds,
      bridgeHash: `pending-${bridgeTxHash}`,
      metadata: '0x',
      leafType: 'asset',
      depositCount: 0,
      transactionIndex: 0,
      transactionHash: bridgeTxHash,
      blockNumber: 0,
      // Best-effort: the token's true origin network (what the real activity
      // row will report as originTokenNetwork) can differ from fromChain when
      // bridging an already-wrapped token onward -- the app has no origin
      // tracking for a selected Token beyond "configured on fromChain", so
      // this approximates it as fromChain itself. Wrong only in that
      // multi-hop case, and only for the few seconds this placeholder is
      // visible before the real row replaces it.
      originTokenAddress: isNative ? ZERO_ADDRESS : selectedToken.address,
      originTokenNetwork: fromChain.networkId,
      timestamp: nowSeconds,
      leafIndex: 0
    });
  }, [
    currentStep,
    bridgeTxHash,
    fromChain,
    toChain,
    selectedToken,
    walletAddress,
    isNative,
    destinationAddress,
    amountWei,
    addPendingBridge
  ]);

  const handleCloseTransactionModal = useCallback(() => {
    setTransactionModalOpen(false);
    execution.reset();
  }, [execution]);

  return (
    <>
      <Card title="Bridge" className="w-full max-w-xl mx-auto space-y-3" data-test-id="bridge-card">
        <BridgeFromSection
          chainOptions={fromChainOptions}
          selectedChainId={form.fromChainId}
          onSelectChain={actions.selectFromChain}
          amount={form.amount}
          onAmountChange={actions.setAmount}
          rawBalance={balance.raw}
          balancesLoading={status.isLoadingBalance}
          selectedToken={form.selectedToken}
          onOpenTokenSelector={() => setTokenModalOpen(true)}
          maxNativeAmount={balance.maxNativeAmount}
        />

        <div className="flex justify-center">
          <button
            type="button"
            onClick={actions.swapChains}
            className="rounded-full border border-border bg-surface p-3 hover:bg-surface-muted cursor-pointer shadow-xs transition-colors"
            aria-label="Swap chains"
          >
            <ArrowDownUp size={18} />
          </button>
        </div>

        <BridgeToSection
          chainOptions={toChainOptions}
          selectedChainId={form.toChainId}
          selectedChainName={derived.toChain?.name}
          onSelectChain={actions.selectToChain}
          destinationAddress={form.destinationAddress}
          onOpenDestinationModal={() => setDestinationModalOpen(true)}
          onClearDestinationAddress={actions.clearDestination}
        />

        {derived.nativeBridgeUrl && (
          <Alert
            type="info"
            title="You'll receive WETH, not native ETH"
            message={
              <>
                Bridging ETH to {derived.toChain?.name ?? 'this network'} this way mints wrapped ETH
                (WETH) there, not native ETH. If you want native ETH on{' '}
                {derived.toChain?.name ?? 'this network'}, use its{' '}
                <a
                  href={derived.nativeBridgeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline hover:no-underline"
                >
                  native bridge
                </a>{' '}
                instead.
              </>
            }
          />
        )}

        <button
          type="button"
          onClick={handleBridgeClick}
          disabled={ctaState.disabled}
          data-test-id="bridge-cta"
          className="w-full rounded-xl bg-primary text-white py-3 font-semibold shadow-xs hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed transition cursor-pointer"
        >
          {ctaState.label}
        </button>
        {form.amount && derived.fromChain && form.selectedToken && (
          <EstimationInfo
            etaMinutes={derived.fromChain.eta}
            fee={gasEstimate.feeFormatted}
            nativeSymbol={derived.fromChain.nativeCurrency.symbol}
            isLoading={gasEstimate.isLoading}
          />
        )}
      </Card>

      <TokenSelector
        open={tokenModalOpen}
        onClose={() => setTokenModalOpen(false)}
        selectedToken={form.selectedToken}
        onSelect={actions.selectToken}
        chainId={form.fromChainId}
        chainName={derived.fromChain?.name}
      />

      {destinationModalOpen && !form.destinationAddress && (
        <DestinationAddressModal
          open={destinationModalOpen}
          onClose={() => setDestinationModalOpen(false)}
          onChangeAddress={handleSetDestination}
        />
      )}

      {transactionModalOpen && form.selectedToken && derived.fromChain && derived.toChain && (
        <BridgeTransactionModal
          open={transactionModalOpen}
          onClose={handleCloseTransactionModal}
          state={execution.state}
          token={form.selectedToken}
          fromChainName={derived.fromChain.name}
          toChainName={derived.toChain.name}
          fromChainIcon={derived.fromChain.icon}
          toChainIcon={derived.toChain.icon}
          amount={form.amount || '0'}
          needsApproval={Boolean(status.needsApproval || execution.state.approvalTxHash)}
          explorerUrl={derived.fromChain.explorer}
        />
      )}
    </>
  );
};

export const BridgeCard = () => {
  const { mode } = useAppMode();
  return <BridgeCardContent key={mode} />;
};
