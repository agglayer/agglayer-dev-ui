'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, FileText, X, CircleUser, Loader2 } from 'lucide-react';
import { ROUTES } from '@/app/constants/routes';
import { EXTERNAL_LINKS } from '@/app/config';
import { cn } from '@/app/utils/common';
import { useWallet } from '@/app/context/wallet';
import { useAppMode } from '@/app/context/appMode';
import { useReadyToClaimCount } from '@/app/hooks/useReadyToClaimCount';
import { setTransactionInitialStatus } from '@/app/components/transactions/intialStatus';
import { ModeSwitch } from '@/app/components/modeSwitch';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const navItems = [
  {
    label: 'Bridge',
    path: ROUTES.ROOT,
    icon: ArrowLeftRight,
  },
  {
    label: 'Transactions',
    path: ROUTES.TRANSACTIONS,
    icon: FileText,
  },
];

export const Sidebar = ({ isOpen, onClose }: SidebarProps) => {
  const pathname = usePathname();
  const { address, chainId } = useWallet();
  const { defaultFromChainId } = useAppMode();

  const effectiveChainId = chainId ?? defaultFromChainId;

  const { data: readyCount } = useReadyToClaimCount({
    chainId: effectiveChainId,
    address,
    enabled: Boolean(address),
  });
  const supportUrl = EXTERNAL_LINKS.CONTACT_SUPPORT;
  const showSupportLink = supportUrl.trim() !== '';

  return (
    <>
      {isOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'fixed lg:static top-0 left-0 h-full',
          'bg-white border-r border-border lg:shadow-none',
          'w-64 z-50 transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex flex-col h-full p-2">
          <div className="lg:hidden flex justify-end">
            <button
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-surface-muted cursor-pointer transition-colors"
            >
              <X size={20} />
            </button>
          </div>
          <nav className="flex-1">
            <ul className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.path;
                return (
                  <li key={item.path}>
                    <Link
                      href={item.path}
                      onClick={() => {
                        if (item.label === 'Transactions' && readyCount && readyCount > 0) {
                          setTransactionInitialStatus('READY_TO_CLAIM');
                        }
                        onClose();
                      }}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg relative cursor-pointer transition-colors',
                        isActive ? 'text-black bg-surface-muted' : 'text-muted hover:bg-surface-muted hover:text-black',
                      )}
                    >
                      {isActive && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue rounded-l" />}
                      <Icon size={20} />
                      <span className="font-medium">{item.label}</span>
                      {item.label === 'Transactions' && typeof readyCount === 'number' && readyCount > 0 && (
                        <div className="flex items-center gap-1 rounded-full bg-blue-subtle text-blue text-xs font-semibold px-2 py-0.5 ml-auto">
                          <Loader2 className="animate-spin" size={12} />
                          <span>{readyCount}</span>
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="space-y-3">
            <ModeSwitch />
            {showSupportLink && (
              <a
                href={supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-3 py-2 text-muted hover:bg-surface-muted hover:text-black rounded-lg cursor-pointer transition-colors"
              >
                <CircleUser size={20} />
                <span className="font-medium">Contact Support</span>
              </a>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
