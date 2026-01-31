'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/app/utils/common';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  showCloseButton?: boolean;
  dismissible?: boolean;
}

export const Modal = ({
  open,
  onClose,
  title,
  children,
  className,
  contentClassName,
  showCloseButton = true,
  dismissible = true,
}: ModalProps) => {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!dismissible) return;
      onClose();
    };

    if (open) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [open, onClose, dismissible]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24">
      <div className="absolute inset-0 bg-black/60" onClick={dismissible ? onClose : undefined} />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 w-130 max-w-[calc(100%-32px)] min-h-60 max-h-[85vh] rounded-2xl bg-surface',
          'border border-border ',
          'overflow-hidden flex flex-col',
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border">
          {title ? <h2 className="text-lg font-semibold">{title}</h2> : <div />}
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              className="flex items-center justify-center rounded-full border border-border bg-surface p-1.5 hover:bg-surface-muted transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <div className={cn('px-6 py-4 flex-1 overflow-y-auto', contentClassName)}>{children}</div>
      </div>
    </div>,
    document.body,
  );
};
