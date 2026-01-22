import Image from 'next/image';
import { useState } from 'react';
import { cn } from '@/app/utils/common';

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface BadgeImageFallbackProps {
  src?: string;
  size?: Size;
  className?: string;
  fallbackText?: string; // Token symbol or chain name for text fallback
}

const sizeClassMap: Record<Size, string> = {
  xs: 'size-4',
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-10',
  xl: 'size-10',
};

const textSizeMap: Record<Size, string> = {
  xs: 'text-[10px]',
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-sm',
  xl: 'text-base',
};

export const BadgeImageFallback: React.FC<BadgeImageFallbackProps> = ({
  src,
  size = 'md',
  className,
  fallbackText,
}) => {
  const [imageError, setImageError] = useState(false);

  const classes = cn('rounded-full shrink-0 bg-grey-light', sizeClassMap[size], className);

  // Show text fallback when image is missing/error and fallbackText is provided
  const shouldShowTextFallback = (!src || imageError) && fallbackText && fallbackText.length > 0;

  if (shouldShowTextFallback) {
    return (
      <div
        className={cn(
          classes,
          'flex items-center justify-center bg-blue-subtle text-black font-semibold',
          textSizeMap[size],
        )}
        aria-label={fallbackText}
      >
        {fallbackText.charAt(0).toUpperCase()}
      </div>
    );
  }

  if (!src || imageError) {
    return <div className={classes} aria-hidden="true" />;
  }

  return (
    <Image
      src={src}
      alt={fallbackText || 'logo'}
      width={100}
      height={100}
      className={classes}
      onError={() => setImageError(true)}
    />
  );
};
