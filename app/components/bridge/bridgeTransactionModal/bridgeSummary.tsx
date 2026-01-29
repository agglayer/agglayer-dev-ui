'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/app/utils/common';

interface BridgeSummaryProps {
  headline: string;
  subheadline: string;
  showLoader: boolean;
  alternateHeadline?: string;
  shouldAlternate?: boolean;
  alignment?: 'left' | 'center';
}

export const BridgeSummary = ({
  headline,
  subheadline,
  showLoader,
  alternateHeadline,
  shouldAlternate = false,
  alignment = 'left',
}: BridgeSummaryProps) => {
  const [useAlternate, setUseAlternate] = useState(false);
  const shouldToggle = Boolean(shouldAlternate && alternateHeadline);
  const isCentered = alignment === 'center';

  useEffect(() => {
    if (!shouldToggle) return;
    const timer = window.setInterval(() => setUseAlternate((prev) => !prev), 1800);
    return () => window.clearInterval(timer);
  }, [shouldToggle]);

  const displayedHeadline = useMemo(() => {
    if (!shouldAlternate || !alternateHeadline) return headline;
    return useAlternate ? alternateHeadline : headline;
  }, [alternateHeadline, headline, shouldAlternate, useAlternate]);

  return (
    <div className={cn('space-y-1.5', isCentered ? 'text-center' : 'text-left')}>
      <div
        className={cn(
          'flex items-center gap-2 text-lg font-semibold text-black',
          isCentered && 'justify-center',
        )}
      >
        {showLoader && <Loader2 className="size-5 text-blue animate-spin" />}
        <span>{displayedHeadline}</span>
      </div>
      <p className="text-muted text-sm">{subheadline}</p>
    </div>
  );
};
