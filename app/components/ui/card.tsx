'use client';

import type { ReactNode } from 'react';
import { cn } from '@/app/utils/common';

interface CardProps {
  children: ReactNode;
  title?: string;
  className?: string;
}

export const Card = ({ children, title, className }: CardProps) => {
  return (
    <div className={cn('rounded-2xl bg-surface border border-border ', 'p-6 space-y-4', className)}>
      {title && <header>{title && <h2 className="text-3xl font-extrabold text-black">{title}</h2>}</header>}
      {children}
    </div>
  );
};
