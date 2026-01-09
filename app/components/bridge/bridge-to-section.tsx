'use client';

import { Dropdown, type DropdownOption } from '@/app/components/ui/dropdown';
import { shortenAddress } from '@/app/utils/address';

interface BridgeToSectionProps {
  chainOptions: DropdownOption[];
  selectedChainId: number;
  selectedChainName?: string;
  onSelectChain: (chainId: number) => void;
  destinationAddress: string;
  onOpenDestinationModal: () => void;
  onClearDestinationAddress: () => void;
}

export const BridgeToSection = ({
  chainOptions,
  selectedChainId,
  selectedChainName,
  onSelectChain,
  destinationAddress,
  onOpenDestinationModal,
  onClearDestinationAddress,
}: BridgeToSectionProps) => {
  const hasDestinationAddress = destinationAddress.length > 0;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-muted">Bridge to</span>
        {hasDestinationAddress ? (
          <span className="text-xs font-semibold text-grey">Custom: {shortenAddress(destinationAddress, 6)}</span>
        ) : (
          <button
            type="button"
            onClick={onOpenDestinationModal}
            className="text-xs font-semibold text-blue hover:underline cursor-pointer"
          >
            Transfer to different address
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px,1fr] gap-3 items-start">
        <Dropdown
          options={chainOptions}
          selectedValue={selectedChainId.toString()}
          onSelect={(option) => onSelectChain(Number(option.value))}
        />

        {hasDestinationAddress ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-3 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-grey">Destination address</span>
                <span className="font-mono text-sm break-all">{destinationAddress}</span>
                <span className="text-xs text-muted">
                  Funds will arrive at this address on {selectedChainName ?? 'the selected network'}.
                </span>
              </div>
              <button
                type="button"
                onClick={onClearDestinationAddress}
                className="text-xs font-semibold text-blue hover:underline cursor-pointer shrink-0"
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted shadow-xs">
            Funds will arrive at your connected address on {selectedChainName ?? 'the selected network'}.
          </div>
        )}
      </div>
    </section>
  );
};
