'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftRight, FileText, X, CircleUser } from 'lucide-react';
import { ROUTES } from '@/app/constants/routes';
import { EXTERNAL_LINKS } from '@/app/constants/externalLinks';
import { cn } from '@/app/utils/common';

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

  return (
    <>
      {isOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'fixed lg:static top-0 left-0 h-full',
          'bg-white border-r border-gray-200',
          'w-64 z-50 transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex flex-col h-full p-2">
          <div className="lg:hidden flex justify-end">
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-md cursor-pointer">
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
                      onClick={onClose}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg relative cursor-pointer',
                        isActive ? 'text-gray-900 bg-gray-50' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
                      )}
                    >
                      {isActive && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500 rounded-l" />}
                      <Icon size={20} />
                      <span className="font-medium">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div>
            <a
              href={EXTERNAL_LINKS.CONTACT_SUPPORT}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-2 text-gray-600 hover:bg-gray-50 hover:text-gray-900 rounded-lg cursor-pointer"
            >
              <CircleUser size={20} />
              <span className="font-medium">Contact Support</span>
            </a>
          </div>
        </div>
      </aside>
    </>
  );
};
