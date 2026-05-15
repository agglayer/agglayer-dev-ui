'use client';

import { CopyText } from '@/app/components/copyText';
import { Button } from '@/app/components/ui/button';
import { ROUTES } from '@/app/constants/routes';
import { useRefetch } from '@/app/context/refetch';
import { shortenAddress } from '@/app/utils/address';
import { Link as LinkIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

interface BridgeSuccessViewProps {
  hash: string;
  explorerUrl?: string;
  onClose: () => void;
}

export const BridgeSuccessView = ({ hash, explorerUrl, onClose }: BridgeSuccessViewProps) => {
  const router = useRouter();
  const { triggerAggressiveRefetch } = useRefetch();

  const handleGoToTransactions = useCallback(() => {
    triggerAggressiveRefetch();
    onClose();
    router.push(ROUTES.TRANSACTIONS);
  }, [onClose, router, triggerAggressiveRefetch]);

  return (
    <div className="flex flex-col gap-3" data-test-id="bridge-success-view">
      <div
        className="flex items-center justify-between px-4 py-3 bg-surface-muted rounded-xl"
        data-test-id="bridge-success-hash-row"
      >
        <div className="flex items-center gap-2 text-black">
          <span>{shortenAddress(hash, 8)}</span>
          <CopyText textToCopy={hash} iconClassName="size-3.5" />
        </div>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-test-id="bridge-success-explorer-link"
            className="text-xs text-blue flex items-center gap-1 font-semibold"
          >
            <LinkIcon className="size-3" aria-hidden />
            View on explorer
          </a>
        )}
      </div>
      <Button
        className="w-full"
        onClick={handleGoToTransactions}
        data-test-id="bridge-success-go-to-transactions"
      >
        Go to transactions
      </Button>
    </div>
  );
};
