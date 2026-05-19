'use client';

import { cn } from '@/app/utils/common';
import { formatDuration } from '@/app/utils/date';
import { Clock, Coins } from 'lucide-react';

interface EstimationInfoProps {
  etaMinutes?: number;
  fee?: string;
  nativeSymbol: string;
  isLoading?: boolean;
  className?: string;
}

export const EstimationInfo = ({
  etaMinutes,
  fee,
  nativeSymbol,
  isLoading,
  className
}: EstimationInfoProps) => {
  const hasEta = etaMinutes !== undefined;
  const hasFee = Boolean(fee) || Boolean(isLoading);
  const feePrefix = fee?.startsWith('<') ? '' : '~';

  if (!hasEta && !hasFee) return null;

  return (
    <div className={cn('flex items-center justify-between text-sm text-grey px-1', className)}>
      {hasEta && (
        <div className="flex items-center gap-1.5">
          <Clock size={14} className="text-grey" />
          <span>Est. time: {formatDuration(etaMinutes)}</span>
        </div>
      )}

      {hasFee && (
        <div className="flex items-center gap-1.5">
          <Coins size={14} className="text-grey" />
          <span>
            {isLoading ? 'Calculating...' : `Est. fee: ${feePrefix}${fee} ${nativeSymbol}`}
          </span>
        </div>
      )}
    </div>
  );
};
