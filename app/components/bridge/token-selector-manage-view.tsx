'use client';

import { useMemo } from 'react';
import { Trash2, ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { TextInput } from '@/app/components/ui/text-input';
import { Alert } from '@/app/components/ui/alert';
import { isValidEthereumAddress, shortenAddress } from '@/app/utils/address';
import { useTokenMetadata } from '@/app/hooks/useTokenMetadata';
import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import type { Token } from '@/app/types/token';
import { Spinner } from '@/app/components/ui/spinner';
import { CopyText } from '@/app/components/copyText';
import { getChainById } from '@/app/constants/chains';
import { getTokenLogoBySymbol } from '@/app/utils/tokens';

interface ManageTokensViewProps {
  chainId?: number;
  chainName?: string;
  customTokenAddress: string;
  onCustomTokenAddressChange: (value: string) => void;
  onBack: () => void;
  onAddCustomToken: (token: Token) => void;
  onRemoveCustomToken: (chainId: number, address: string) => void;
  customTokens: Token[];
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
}) => {
  const trimmedAddress = customTokenAddress.trim();
  const isValidInput = isValidEthereumAddress(trimmedAddress);
  const effectiveQueryAddress = isValidInput ? trimmedAddress : null;
  const chain = chainId ? getChainById(chainId) : undefined;
  const explorerBase = chain?.explorer;

  const { data, isFetching, isError, error, isSuccess } = useTokenMetadata({
    chainId,
    tokenAddress: effectiveQueryAddress ?? undefined,
    enabled: Boolean(effectiveQueryAddress),
  });

  const handleAdd = () => {
    if (!data || !chainId) return;
    const token: Token = {
      chainId,
      address: data.tokenAddress,
      decimals: data.decimals,
      symbol: data.symbol,
      name: data.name,
      logoURI: data.logoURI,
      isCustom: true,
    };
    onAddCustomToken(token);
  };

  const filteredCustomTokens = useMemo(
    () => (chainId ? customTokens.filter((token) => token.chainId === chainId) : customTokens),
    [chainId, customTokens],
  );

  const existingToken = useMemo(() => {
    if (!effectiveQueryAddress) return undefined;
    return filteredCustomTokens.find(
      (token) => token.address.toLowerCase() === effectiveQueryAddress.toLowerCase() && token.chainId === chainId,
    );
  }, [filteredCustomTokens, effectiveQueryAddress, chainId]);

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
          <Spinner size="sm" />
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
              variant="token"
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
              <span className="rounded-full bg-blue/10 text-blue text-[11px] px-2 py-0.5 font-semibold">Imported</span>
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
                <span className="font-semibold text-black">{shortenAddress(data.tokenAddress, 6)}</span>
                <CopyText
                  textToCopy={data.tokenAddress}
                  buttonClassName="rounded-full border border-border bg-surface p-1.5 text-muted hover:text-black hover:border-blue transition-colors"
                  iconClassName="size-3.5"
                />
                {explorerBase && (
                  <button
                    type="button"
                    className="rounded-full border border-border bg-surface p-1.5 text-muted hover:text-black hover:border-blue transition-colors"
                    onClick={() => window.open(`${explorerBase}/address/${data.tokenAddress}`, '_blank')}
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

          <Button onClick={handleAdd} disabled={!canAdd} className="w-full">
            {existingToken ? 'Already added' : `Add ${data.symbol} token`}
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
                onClick={() => filteredCustomTokens.forEach((t) => onRemoveCustomToken(t.chainId, t.address))}
                className="text-xs font-semibold text-blue hover:underline cursor-pointer"
              >
                Delete all
              </button>
            )}
          </div>

          {filteredCustomTokens.length === 0 && (
            <div className="rounded-xl border border-border bg-surface px-3 py-3 text-sm text-muted shadow-xs">
              No custom tokens added yet.
            </div>
          )}

          {filteredCustomTokens.length > 0 && (
            <div className="space-y-2">
              {filteredCustomTokens.map((token) => (
                <div
                  key={`${token.chainId}-${token.address}`}
                  className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 shadow-xs"
                >
                  <div className="flex items-center gap-3">
                    <BadgeImageFallback variant="token" src={token.logoURI} size="sm" fallbackText={token.symbol} />
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-black">{token.symbol}</span>
                      <span className="text-xs text-grey">{token.name}</span>
                      <span className="text-[11px] text-muted font-mono break-all">
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
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
