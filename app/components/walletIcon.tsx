import { cn } from '@/app/utils/common';
import { Wallet } from 'lucide-react';
import Image from 'next/image';

interface WalletIconProps {
  walletIcon?: string;
  className?: string;
}

export const WalletIcon: React.FC<WalletIconProps> = ({ walletIcon, className }) => {
  if (!walletIcon) {
    return <Wallet className={cn('rounded-full size-4', className)} />;
  }
  return (
    <Image
      src={walletIcon}
      alt="Wallet Icon"
      width={100}
      height={100}
      className={cn('rounded-full size-4', className)}
    />
  );
};
