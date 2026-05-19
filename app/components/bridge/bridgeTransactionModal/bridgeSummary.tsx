'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface BridgeSummaryProps {
  headline: string;
  subheadline: string;
  showLoader: boolean;
  alternateHeadline?: string;
  shouldAlternate?: boolean;
}

export const BridgeSummary = ({
  headline,
  subheadline,
  showLoader,
  alternateHeadline,
  shouldAlternate = false
}: BridgeSummaryProps) => {
  const [useAlternate, setUseAlternate] = useState(false);
  const shouldToggle = Boolean(shouldAlternate && alternateHeadline);

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
    <div className="space-y-2 text-center">
      <div className="text-lg font-semibold text-black flex items-center justify-center gap-2">
        {showLoader && <Loader2 className="size-5 text-blue animate-spin" />}
        <span data-test-id="bridge-modal-headline">{displayedHeadline}</span>
      </div>
      <p className="text-muted text-sm">{subheadline}</p>
    </div>
  );
};
