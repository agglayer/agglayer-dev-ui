'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Copy } from 'lucide-react';
import { cn } from '@/app/utils/common';

interface CopyTextProps {
  textToCopy: string;
  buttonClassName?: string;
  iconClassName?: string;
}

const COPY_FEEDBACK_DURATION = 1200;

export const CopyText: React.FC<CopyTextProps> = ({ textToCopy, buttonClassName = '', iconClassName = 'size-4' }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        await navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        clearTimer();
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, COPY_FEEDBACK_DURATION);
      } catch (error) {
        console.error('Failed to copy text', error);
      }
    },
    [clearTimer, textToCopy],
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'flex items-center justify-center cursor-pointer hover:opacity-70 focus:outline-none',
          buttonClassName,
        )}
        aria-label="Copy to clipboard"
      >
        <Copy className={cn('size-4', iconClassName)} />
      </button>
      {copied && (
        <span
          role="status"
          aria-live="polite"
          className="absolute -top-8 right-0 w-max max-w-xs rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium shadow-sm"
        >
          Copied
        </span>
      )}
    </div>
  );
};
