'use client';

import { BadgeImageFallback } from '@/app/components/ui/badge-image-fallback';
import Image from 'next/image';

interface RouteVisualProps {
  fromChainIcon?: string;
  toChainIcon?: string;
  tokenLogo?: string;
  fromChainName: string;
  toChainName: string;
  tokenSymbol: string;
}

export const RouteVisual = ({
  fromChainIcon,
  toChainIcon,
  tokenLogo,
  fromChainName,
  toChainName,
  tokenSymbol,
}: RouteVisualProps) => {
  const dashes = Array.from({ length: 6 }).map((_, idx) => (
    <span className="flex-1 flex items-center justify-center" key={idx}>
      <span className="h-0.5 w-4 rounded-sm bg-grey" />
    </span>
  ));

  return (
    <div className="w-full rounded-xl bg-surface-muted p-6 flex items-center">
      {fromChainIcon ? (
        <Image
          alt={`${fromChainName} logo`}
          height={100}
          width={100}
          className="size-12 rounded-sm"
          src={fromChainIcon}
        />
      ) : (
        <div className="size-12 rounded-sm bg-grey" />
      )}
      <span className="w-2 h-0.5 bg-grey rounded-sm" />
      <BadgeImageFallback src={tokenLogo} size="md" fallbackText={tokenSymbol} />
      <span className="w-2 h-0.5 bg-grey rounded-sm" />
      {dashes}
      {toChainIcon ? (
        <Image alt={`${toChainName} logo`} height={100} width={100} className="size-12 rounded-sm" src={toChainIcon} />
      ) : (
        <div className="size-12 rounded-sm bg-grey" />
      )}
    </div>
  );
};
