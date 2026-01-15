'use client';

import { useCallback } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/app/components/ui/button';
import { CopyText } from '@/app/components/copyText';
import { ROUTES } from '@/app/constants/routes';
import { shortenAddress } from '@/app/utils/address';
import { triggerAggressiveRefetch } from '@/app/utils/refetchTrigger';

interface BridgeSuccessViewProps {
  hash: string;
  explorerUrl?: string;
  onClose: () => void;
}

export const BridgeSuccessView = ({ hash, explorerUrl, onClose }: BridgeSuccessViewProps) => {
  const router = useRouter();

  const handleGoToTransactions = useCallback(() => {
    triggerAggressiveRefetch();
    onClose();
    router.push(ROUTES.TRANSACTIONS);
  }, [onClose, router]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-4 py-3 bg-surface-muted rounded-xl">
        <div className="flex items-center gap-2 text-black">
          <span>{shortenAddress(hash, 8)}</span>
          <CopyText textToCopy={hash} iconClassName="size-3.5" />
        </div>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue flex items-center gap-1 font-semibold"
          >
            <LinkIcon className="size-3" aria-hidden />
            View on explorer
          </a>
        )}
      </div>
      <Button className="w-full" onClick={handleGoToTransactions}>
        Go to transactions
      </Button>
    </div>
  );
};
