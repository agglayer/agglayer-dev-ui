'use client';

import { MENU_LINKS } from '@/app/components/header/constants';
import { ModeSwitch } from '@/app/components/modeSwitch';
import { useClickOutside } from '@/app/hooks/useClickOutside';
import { cn } from '@/app/utils/common';
import { EllipsisVertical } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

interface HeaderPopoverProps {
  hasModeOptions: boolean;
}

export const HeaderPopover = ({ hasModeOptions }: HeaderPopoverProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside([popoverRef], close, isOpen);

  return (
    <div ref={popoverRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-label="Open menu"
        className="flex size-10 items-center justify-center rounded-full border border-border hover:bg-surface-muted transition-colors cursor-pointer"
      >
        <EllipsisVertical className="size-5" />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-64 rounded-2xl border border-border bg-surface p-2 shadow-sm z-50">
          {hasModeOptions && (
            <div className="space-y-2 pb-2 text-sm">
              <ModeSwitch />
            </div>
          )}
          <div className={cn('space-y-1', hasModeOptions ? 'border-t border-border pt-2' : '')}>
            {MENU_LINKS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-lg px-3 py-2 text-sm text-black hover:bg-surface-muted transition-colors"
                onClick={close}
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
