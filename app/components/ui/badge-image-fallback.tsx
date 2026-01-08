import { cn } from '@/app/utils/common';
import Image from 'next/image';
import { useState } from 'react';

type Variant = 'token' | 'chain';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface BadgeImageFallbackProps {
  src?: string;
  variant: Variant;
  size: Size;
  className?: string;
  fallbackText?: string; // Token symbol or chain name for text fallback
}

const sizeClassMap: Record<Variant, Record<Size, string>> = {
  token: {
    xs: 'size-4',
    sm: 'size-6',
    md: 'size-8',
    lg: 'size-10',
  },
  chain: {
    xs: 'size-4',
    sm: 'size-4',
    md: 'size-4',
    lg: 'size-5',
  },
};

const textSizeMap: Record<Size, string> = {
  xs: 'text-[10px]',
  sm: 'text-xs',
  md: 'text-xs',
  lg: 'text-sm',
};

export const BadgeImageFallback: React.FC<BadgeImageFallbackProps> = ({
  src,
  variant,
  size,
  className,
  fallbackText,
}) => {
  const [imageError, setImageError] = useState(false);

  const classes = cn('rounded-full shrink-0 bg-grey-light', sizeClassMap[variant][size], className);

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
        aria-label={`${fallbackText} ${variant}`}
      >
        {fallbackText.charAt(0).toUpperCase()}
      </div>
    );
  }

  if (!src || imageError) {
    return <div className={classes} aria-hidden="true" />;
  }

  return (
    <Image src={src} alt={variant} width={100} height={100} className={classes} onError={() => setImageError(true)} />
  );
};
