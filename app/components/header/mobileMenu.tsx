'use client';

import { MENU_LINKS, NAV_ITEMS } from '@/app/components/header/constants';
import { HeaderNavLink } from '@/app/components/header/headerNavLink';
import { ModeSwitch } from '@/app/components/modeSwitch';
import { Logo } from '@/app/components/ui/logo';
import { ROUTES } from '@/app/constants/routes';
import { cn } from '@/app/utils/common';
import { ExternalLink, X } from 'lucide-react';
import { ReactNode } from 'react';

interface MobileMenuProps {
  isOpen: boolean;
  onClose: () => void;
  pathname: string;
  onNavClick: (path: string) => void;
  hasModeOptions: boolean;
  readyCountBadge: ReactNode | null;
}

export const MobileMenu = ({
  isOpen,
  onClose,
  pathname,
  onNavClick,
  hasModeOptions,
  readyCountBadge,
}: MobileMenuProps) => {
  if (!isOpen) return null;

  return (
    <div
      id="mobile-nav"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex h-full flex-col bg-surface p-4 md:hidden"
    >
      <div className="flex items-center justify-between p-2">
        <Logo />
        <button
          type="button"
          aria-label="Close navigation menu"
          onClick={onClose}
          className="rounded-full p-2 hover:bg-surface-muted transition-colors cursor-pointer"
        >
          <X className="size-6" />
        </button>
      </div>
      <div className="flex flex-1 flex-col px-2">
        <nav className="mt-6 flex flex-col gap-3">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.path;
            return (
              <HeaderNavLink
                key={`mobile-${item.path}`}
                href={item.path}
                label={item.label}
                isActive={isActive}
                onClick={() => onNavClick(item.path)}
                className={cn('text-2xl rounded-2xl', isActive ? 'text-blue' : 'text-black')}
              >
                {item.path === ROUTES.TRANSACTIONS ? readyCountBadge : null}
              </HeaderNavLink>
            );
          })}
        </nav>
        <div className="flex flex-col gap-3 mt-3">
          {MENU_LINKS.map((item) => (
            <a
              key={`mobile-${item.label}`}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="flex items-center rounded-xl font-semibold text-2xl text-black hover:bg-surface transition-colors"
            >
              {item.label}
              <ExternalLink size={16} className="ml-2" />
            </a>
          ))}
        </div>
        <div className="mt-auto space-y-4">
          {hasModeOptions && (
            <div className="text-xl font-semibold m-0">
              <ModeSwitch />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
