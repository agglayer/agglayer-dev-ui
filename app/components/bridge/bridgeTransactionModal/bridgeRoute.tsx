'use client';

import { ArrowRight } from 'lucide-react';
import Image from 'next/image';

interface BridgeRouteProps {
  fromChainIcon?: string;
  toChainIcon?: string;
  fromChainName: string;
  toChainName: string;
}

const ChainInline = ({ icon, name }: { icon?: string; name: string }) => (
  <span className="inline-flex items-center gap-2">
    {icon ? (
      <Image alt={`${name} logo`} height={100} width={100} className="size-7 rounded-sm" src={icon} />
    ) : (
      <span className="size-7 rounded-sm bg-grey" />
    )}
    <span className="text-base font-semibold text-black">{name}</span>
  </span>
);

export const BridgeRoute = ({ fromChainIcon, toChainIcon, fromChainName, toChainName }: BridgeRouteProps) => {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
      <ChainInline icon={fromChainIcon} name={fromChainName} />
      <ArrowRight className="size-3.5 text-grey" />
      <ChainInline icon={toChainIcon} name={toChainName} />
    </div>
  );
};
