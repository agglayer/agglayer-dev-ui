'use client';

import { cn } from '@/app/utils/common';

type SpinnerSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'size-3 border-2',
  md: 'size-4 border-2',
  lg: 'size-6 border-[3px]',
  xl: 'size-12 border-4',
};

interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 'lg', className }) => {
  return (
    <div
      className={cn(
        'inline-block animate-spin rounded-full border-border border-t-blue',
        SIZE_CLASSES[size],
        className,
      )}
    />
  );
};
