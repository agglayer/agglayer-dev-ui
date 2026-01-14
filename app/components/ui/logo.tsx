import { cn } from '@/app/utils/common';
import Image from 'next/image';

export const Logo = ({ className }: { className?: string }) => (
  <div className={cn('flex items-center gap-3', className)}>
    <Image src="/logo-icon.png" alt="Agglayer logo" width={40} height={40} priority />
    <div className="flex items-center gap-2">
      <Image src="/logo-text.png" alt="Agglayer" height={22} width={85} priority />
    </div>
  </div>
);
