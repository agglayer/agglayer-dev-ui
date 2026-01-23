'use client';

import { useCallback, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, Menu } from 'lucide-react';
import { ROUTES } from '@/app/constants/routes';
import { ConnectButton } from '@/app/components/connectButton';
import { Logo } from '@/app/components/ui/logo';
import { useWallet } from '@/app/context/wallet';
import { useAppMode } from '@/app/context/appMode';
import { useReadyToClaimCount } from '@/app/hooks/useReadyToClaimCount';
import { setTransactionInitialStatus } from '@/app/components/transactions/intialStatus';
import { HeaderNavLink } from '@/app/components/header/headerNavLink';
import { HeaderPopover } from '@/app/components/header/headerPopover';
import { MobileMenu } from '@/app/components/header/mobileMenu';
import { NAV_ITEMS } from '@/app/components/header/constants';

export const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const pathname = usePathname();
  const { address, chainId } = useWallet();
  const { defaultFromChainId, enabledModes, mode } = useAppMode();

  const effectiveChainId = chainId ?? defaultFromChainId;
  const hasModeOptions = enabledModes.some((value) => value !== mode);

  const { data: readyCount } = useReadyToClaimCount({
    chainId: effectiveChainId,
    address,
    enabled: Boolean(address),
  });

  const readyCountValue = typeof readyCount === 'number' ? readyCount : 0;
  const hasReadyCount = readyCountValue > 0;

  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  const handleNavClick = useCallback(
    (path: string) => {
      if (path === ROUTES.TRANSACTIONS && hasReadyCount) {
        setTransactionInitialStatus('READY_TO_CLAIM');
      }
      closeMenu();
    },
    [closeMenu, hasReadyCount],
  );

  const readyCountBadge = hasReadyCount ? (
    <span className="flex items-center gap-1 rounded-full bg-blue-subtle text-blue text-xs font-semibold px-2 py-0.5">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      <span>{readyCountValue}</span>
    </span>
  ) : null;

  return (
    <>
      <div className="w-full max-w-7xl mx-auto my-4 md:my-6 px-3">
        <div className="rounded-[28px] border border-border bg-surface p-2 shadow-xs">
          <div className="flex w-full items-center gap-3">
            <Logo />
            <nav className="hidden md:flex flex-1 items-center justify-center gap-6">
              {NAV_ITEMS.map((item) => (
                <HeaderNavLink
                  key={item.path}
                  href={item.path}
                  label={item.label}
                  isActive={pathname === item.path}
                  onClick={() => handleNavClick(item.path)}
                >
                  {item.path === ROUTES.TRANSACTIONS ? readyCountBadge : null}
                </HeaderNavLink>
              ))}
            </nav>
            <div className="ml-auto hidden md:flex items-center gap-2">
              <ConnectButton />
              <HeaderPopover hasModeOptions={hasModeOptions} />
            </div>
            <div className="ml-auto flex items-center gap-2 md:hidden">
              <ConnectButton />
              <button
                type="button"
                onClick={() => setIsMenuOpen(true)}
                aria-label="Open navigation menu"
                aria-expanded={isMenuOpen}
                aria-controls="mobile-nav"
                className="flex size-10 items-center justify-center rounded-full border border-border"
              >
                <Menu className="size-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <MobileMenu
        isOpen={isMenuOpen}
        onClose={closeMenu}
        pathname={pathname}
        onNavClick={handleNavClick}
        hasModeOptions={hasModeOptions}
        readyCountBadge={readyCountBadge}
      />
    </>
  );
};
