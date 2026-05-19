'use client';

import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/app/utils/common';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  title?: string;
}

export const Card = ({ children, title, className, ...rest }: CardProps) => {
  return (
    <div
      className={cn('rounded-2xl bg-surface border border-border ', 'p-6 space-y-4', className)}
      {...rest}
    >
      {title && (
        <header>{title && <h2 className="text-3xl font-extrabold text-black">{title}</h2>}</header>
      )}
      {children}
    </div>
  );
};
