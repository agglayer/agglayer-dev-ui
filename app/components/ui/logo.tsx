import { cn } from '@/app/utils/common';
import Image from 'next/image';

export const Logo = ({ className }: { className?: string }) => (
  <div className={cn('flex items-center gap-3', className)}>
    <Image src="/logo-icon.png" alt="Agglayer logo" width={40} height={40} priority />
    <div className="flex items-center gap-2">
      <Image src="/logo-text.png" alt="Agglayer" height={22} width={85} priority />
      <span className="py-0.5 px-2 bg-grey-light font-semibold text-black rounded-md text-xs">DEV</span>
    </div>
  </div>
);
