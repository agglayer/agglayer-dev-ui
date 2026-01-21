'use client';

import { ArrowRight } from 'lucide-react';
import Image from 'next/image';

interface RouteVisualProps {
  fromChainIcon?: string;
  toChainIcon?: string;
  tokenLogo?: string;
  fromChainName: string;
  toChainName: string;
  tokenSymbol: string;
}

const ChainCard = ({ icon, name }: { icon?: string; name: string }) => (
  <div className="flex flex-1 flex-col items-center gap-2 rounded-lg bg-surface-muted p-4 border-2 border-border">
    {icon ? (
      <Image alt={`${name} logo`} height={100} width={100} className="size-10 rounded-sm" src={icon} />
    ) : (
      <div className="size-10 rounded-sm bg-grey" />
    )}
    <span className="text-lg font-bold">{name}</span>
  </div>
);

export const RouteVisual = ({
  fromChainIcon,
  toChainIcon,
  fromChainName,
  toChainName,
}: RouteVisualProps) => {
  return (
    <div className="flex w-full items-center gap-3">
      <ChainCard icon={fromChainIcon} name={fromChainName} />
      <div className="flex items-center justify-center">
        <ArrowRight className="size-5 text-grey" />
      </div>
      <ChainCard icon={toChainIcon} name={toChainName} />
    </div>
  );
};
