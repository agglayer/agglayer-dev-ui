'use client';

import { useWallet } from '@/app/context/wallet';
import { shortenAddress } from '@/app/utils/address';
import { CopyText } from '@/app/components/copyText';
import { WalletIcon } from '@/app/components/walletIcon';
import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/app/components/ui/button';

export const ConnectButton = () => {
  const { connect, address, status, disconnect, walletIcon } = useWallet();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsPopoverOpen(false);
      }
    };

    if (isPopoverOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isPopoverOpen]);

  if (status === 'connected' && address) {
    return (
      <div className="relative" ref={popoverRef}>
        <button
          onClick={() => setIsPopoverOpen(!isPopoverOpen)}
          className="flex items-center gap-2 py-2 px-4 bg-surface text-black border border-border rounded-3xl hover:bg-surface-muted cursor-pointer shadow-xs transition-colors"
        >
          <WalletIcon walletIcon={walletIcon} className="size-5" />
          {shortenAddress(address)}
          <ChevronDown size={16} />
        </button>

        {isPopoverOpen && (
          <div className="absolute top-full right-0 mt-2 w-64 bg-surface border border-border rounded-xl  z-50">
            <div className="p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="text-sm font-mono text-black break-all">{shortenAddress(address, 8)}</div>
                <CopyText textToCopy={address} />
              </div>
              <button
                onClick={() => {
                  disconnect();
                  setIsPopoverOpen(false);
                }}
                className="w-full py-2 px-4 text-sm text-black hover:bg-surface-muted rounded-lg cursor-pointer border border-border transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Button className="rounded-3xl" onClick={connect}>
      Connect Wallet
    </Button>
  );
};
