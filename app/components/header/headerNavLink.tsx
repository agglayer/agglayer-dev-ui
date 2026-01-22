import { cn } from '@/app/utils/common';
import Link from 'next/link';
import { ReactNode } from 'react';

interface HeaderNavLinkProps {
  href: string;
  label: string;
  isActive: boolean;
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}

export const HeaderNavLink = ({ href, label, isActive, onClick, className, children }: HeaderNavLinkProps) => (
  <Link
    href={href}
    onClick={onClick}
    className={cn(
      'flex items-center gap-2 font-semibold transition-colors',
      isActive ? 'text-black' : 'text-muted hover:text-black',
      className,
    )}
  >
    <span>{label}</span>
    {children}
  </Link>
);
