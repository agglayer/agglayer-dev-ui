'use client';

import { useWallet } from '@/app/context/wallet';
import { shortenAddress } from '@/app/utils/address';
import { CopyText } from '@/app/components/copyText';
import { WalletIcon } from '@/app/components/walletIcon';
import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

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
          className="flex items-center gap-2 py-2 px-4 bg-gray-200  rounded-md hover:bg-gray-300 cursor-pointer"
        >
          <WalletIcon walletIcon={walletIcon} className="size-5" />
          {shortenAddress(address)}
          <ChevronDown size={16} />
        </button>

        {isPopoverOpen && (
          <div className="absolute top-full right-0 mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
            <div className="p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="text-sm font-mono text-gray-900 break-all">{shortenAddress(address, 8)}</div>
                <CopyText textToCopy={address} />
              </div>
              <button
                onClick={() => {
                  disconnect();
                  setIsPopoverOpen(false);
                }}
                className="w-full py-2 px-4 text-sm text-gray-700 hover:bg-gray-50 rounded-md cursor-pointer border border-gray-200"
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
    <button
      onClick={connect}
      className="py-2 px-4 bg-blue-500 text-white rounded-md hover:bg-blue-600 font-bold cursor-pointer"
    >
      Connect Wallet
    </button>
  );
};
