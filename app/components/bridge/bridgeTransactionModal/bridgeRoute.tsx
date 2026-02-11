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
  <span className="flex items-center gap-2">
    {icon ? (
      <Image alt={`${name} logo`} height={100} width={100} className="size-7 rounded-sm" src={icon} />
    ) : (
      <span className="size-7 rounded-sm bg-grey" />
    )}
    <span className="text-lg font-semibold text-black">{name}</span>
  </span>
);

export const BridgeRoute = ({ fromChainIcon, toChainIcon, fromChainName, toChainName }: BridgeRouteProps) => {
  return (
    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
      <div className="flex justify-end pr-2">
        <ChainInline icon={fromChainIcon} name={fromChainName} />
      </div>
      <ArrowRight className="size-3.5 text-grey" />
      <div className="flex justify-start pl-2">
        <ChainInline icon={toChainIcon} name={toChainName} />
      </div>
    </div>
  );
};
