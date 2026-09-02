'use client';

import type { ReactNode } from 'react';

import { cn } from '@/app/utils/common';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}

// CSS-only hover tooltip (no JS state, no new dependency): the trigger and
// bubble are siblings inside a `group`, and the bubble's visibility is
// driven entirely by `group-hover`/`group-focus-within`, so it also shows
// on keyboard focus of a focusable trigger.
export const Tooltip = ({ content, children, className }: TooltipProps) => (
  <span className={cn('group relative inline-flex', className)}>
    {children}
    <span
      role="tooltip"
      className={cn(
        'pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-56',
        '-translate-x-1/2 rounded-lg bg-black px-2 py-1 text-center text-xs text-white',
        'opacity-0 shadow-lg transition-opacity duration-150',
        'group-hover:opacity-100 group-focus-within:opacity-100'
      )}
    >
      {content}
    </span>
  </span>
);
