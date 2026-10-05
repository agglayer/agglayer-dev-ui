'use client';

import type { Token } from '@/app/types/token';

import { CopyText } from '@/app/components/copyText';
import { Alert } from '@/app/components/ui/alert';
import { BadgeImageFallback } from '@/app/components/ui/badgeImageFallback';
import { Button } from '@/app/components/ui/button';
import { TextInput } from '@/app/components/ui/textInput';
import { useAggkitAggregator } from '@/app/context/aggLayerSdk';
import { useAppMode } from '@/app/context/appMode';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';
import { resolveTokenToOrigin } from '@/app/services/wrappedTokens';
import { isValidEthereumAddress, shortenAddress } from '@/app/utils/address';
import { getChainById } from '@/app/utils/chains';
import { getTokenLogoBySymbol } from '@/app/utils/tokens';
import { Trash2, ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

interface ManageTokensViewProps {
  chainId?: number;
  chainName?: string;
  customTokenAddress: string;
  onCustomTokenAddressChange: (value: string) => void;
  onBack: () => void;
  onAddCustomToken: (token: Token) => void;
  onRemoveCustomToken: (chainId: number, address: string) => void;
  customTokens: Token[];
  computedTokens: Token[];
}

export const ManageTokensView: React.FC<ManageTokensViewProps> = ({
  chainId,
  chainName,
  customTokenAddress,
  onCustomTokenAddressChange,
  onBack,
  onAddCustomToken,
  onRemoveCustomToken,
  customTokens,
  computedTokens
}) => {
  const { chains } = useAppMode();
  const aggregator = useAggkitAggregator();
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const trimmedAddress = customTokenAddress.trim();
  const isValidInput = isValidEthereumAddress(trimmedAddress);
  const effectiveQueryAddress = isValidInput ? trimmedAddress : null;
  const chain = chainId ? getChainById(chains, chainId) : undefined;
  const explorerBase = chain?.explorer;

  const { data, isFetching, isError, error, isSuccess } = useTokenMetadata({
    chainId,
    tokenAddress: effectiveQueryAddress ?? undefined,
    enabled: Boolean(effectiveQueryAddress)
  });

  // The user may be adding a wrapped token (e.g. the WUSDC they see on an L2).
  // It is stored as its real origin token, which then resolves back to the
  // wrapped address on this network (see app/context/token.tsx).
  const handleAdd = async () => {
    if (!data || !chainId) return;
    setIsAdding(true);
    setAddError(null);
    try {
      const origin = await resolveTokenToOrigin({
        aggregator,
        chains,
        chainId,
        tokenAddress: data.tokenAddress,
        metadata: data
      });
      onAddCustomToken({
        chainId: origin.chainId,
        address: origin.metadata.tokenAddress,
        decimals: origin.metadata.decimals,
        symbol: origin.metadata.symbol,
        name: origin.metadata.name,
        logoURI: origin.metadata.logoURI || getTokenLogoBySymbol(origin.metadata.symbol),
        isCustom: true
      });
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Unable to add this token');
    } finally {
      setIsAdding(false);
    }
  };

  const filteredCustomTokens = useMemo(
    () => (chainId ? customTokens.filter((token) => token.chainId === chainId) : customTokens),
    [chainId, customTokens]
  );

  const filteredComputedTokens = useMemo(
    () => (chainId ? computedTokens.filter((token) => token.chainId === chainId) : computedTokens),
    [chainId, computedTokens]
  );

  const existingToken = useMemo(() => {
    if (!effectiveQueryAddress) return undefined;
    return [...filteredCustomTokens, ...filteredComputedTokens].find(
      (token) =>
        token.address.toLowerCase() === effectiveQueryAddress.toLowerCase() &&
        token.chainId === chainId
    );
  }, [filteredCustomTokens, filteredComputedTokens, effectiveQueryAddress, chainId]);

  const canAdd = Boolean(data && !existingToken);

  const shouldShowCustomList = trimmedAddress.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm font-semibold text-blue hover:underline cursor-pointer w-fit"
      >
        <ArrowLeft size={14} />
        <span>Back to list</span>
      </button>

      <TextInput
        value={customTokenAddress}
        onChange={onCustomTokenAddressChange}
        placeholder="0x..."
        label={`Token address${chainName ? ` on ${chainName}` : ''}`}
        isError={!!customTokenAddress && !isValidInput}
        isSearch
      />

      {isFetching && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-3 shadow-xs text-sm text-muted">
          <Loader2 className="size-5 text-muted animate-spin" />
          <span>Fetching token metadata...</span>
        </div>
      )}

      {isError && (
        <Alert
          type="danger"
          title="Something went wrong"
          message={error instanceof Error ? error.message : 'Unable to fetch token metadata'}
        />
      )}

      {isSuccess && data && (
        <div className="space-y-3 rounded-xl border border-border bg-surface px-3 py-3 shadow-xs">
          <div className="flex items-center gap-3">
            <BadgeImageFallback
              src={data.logoURI || getTokenLogoBySymbol(data.symbol)}
              size="lg"
              fallbackText={data.symbol}
            />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-black">
                {data.symbol} <span className="text-muted font-normal">({data.name})</span>
              </span>
              <span className="text-xs text-grey">{shortenAddress(data.tokenAddress)}</span>
            </div>
            {existingToken && (
              <span className="rounded-full bg-blue-light text-blue text-xs px-2 py-0.5 font-semibold">
                Imported
              </span>
            )}
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2">
              <span className="text-xs text-grey">Symbol</span>
              <span className="font-semibold text-black">{data.symbol}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2">
              <span className="text-xs text-grey">Decimals</span>
              <span className="font-semibold text-black">{data.decimals}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2">
              <span className="text-xs text-grey">Chain</span>
              <span className="font-semibold text-black">{chainName ?? 'Selected network'}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2">
              <span className="text-xs text-grey">Address</span>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-black">
                  {shortenAddress(data.tokenAddress, 6)}
                </span>
                <CopyText
                  textToCopy={data.tokenAddress}
                  buttonClassName="rounded-full border border-border bg-surface p-1.5 text-muted hover:text-black hover:border-blue transition-colors"
                  iconClassName="size-3.5"
                />
                {explorerBase && (
                  <button
                    type="button"
                    className="rounded-full border border-border bg-surface p-1.5 text-muted hover:text-black hover:border-blue transition-colors"
                    onClick={() =>
                      window.open(`${explorerBase}/address/${data.tokenAddress}`, '_blank')
                    }
                    aria-label="Open in explorer"
                  >
                    <ExternalLink size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <Alert
            title="Verify token details"
            message="This token was imported from an external source. Double-check the address before proceeding."
          />

          {addError && <Alert type="danger" title="Could not add token" message={addError} />}

          <Button onClick={handleAdd} disabled={!canAdd || isAdding} className="w-full">
            {existingToken ? 'Already added' : isAdding ? 'Adding...' : `Add ${data.symbol} token`}
          </Button>
        </div>
      )}

      {shouldShowCustomList && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-muted">Your custom tokens</span>
              <span className="text-xs text-grey">Stored locally in your browser.</span>
            </div>
            {filteredCustomTokens.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  filteredCustomTokens.forEach((t) => onRemoveCustomToken(t.chainId, t.address))
                }
                className="text-xs font-semibold text-blue hover:underline cursor-pointer"
              >
                Delete all
              </button>
            )}
          </div>

          {filteredCustomTokens.length === 0 && filteredComputedTokens.length === 0 && (
            <div className="rounded-xl border border-border bg-surface px-3 py-3 text-sm text-muted shadow-xs">
              No custom tokens added yet.
            </div>
          )}

          {(filteredCustomTokens.length > 0 || filteredComputedTokens.length > 0) && (
            <div className="space-y-2 max-h-80 overflow-y-auto py-2">
              {filteredCustomTokens.map((token) => {
                const tokenLogo = token.logoURI || getTokenLogoBySymbol(token.symbol);
                return (
                  <div
                    key={`${token.chainId}-${token.address}`}
                    className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      <BadgeImageFallback src={tokenLogo} size="md" fallbackText={token.symbol} />
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold text-black">{token.symbol}</span>
                        <span className="text-xs text-grey">{token.name}</span>
                        <span className="text-xs text-muted font-mono break-all">
                          {shortenAddress(token.address, 6)}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveCustomToken(token.chainId, token.address)}
                      className="rounded-full border border-border bg-surface-muted cursor-pointer p-2 text-grey hover:text-black hover:border-slate-300 transition-colors"
                      aria-label={`Delete ${token.symbol}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
              {filteredComputedTokens.map((token) => {
                const tokenLogo = token.logoURI || getTokenLogoBySymbol(token.symbol);
                const sourceChain = token.sourceToken
                  ? getChainById(chains, token.sourceToken.chainId)
                  : undefined;
                return (
                  <div
                    key={`${token.chainId}-${token.address}`}
                    className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 shadow-xs"
                  >
                    <div className="flex items-center gap-3">
                      <BadgeImageFallback src={tokenLogo} size="md" fallbackText={token.symbol} />
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold text-black">{token.symbol}</span>
                        <span className="text-xs text-grey">{token.name}</span>
                        <span className="text-xs text-muted font-mono break-all">
                          {shortenAddress(token.address, 6)}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs text-grey text-right">
                      Wrapped token
                      {sourceChain ? `. Remove it from ${sourceChain.name}.` : '.'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
