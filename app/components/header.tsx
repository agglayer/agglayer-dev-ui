'use client';

import { useState, useRef, useEffect } from 'react';
import { EllipsisVertical, Menu } from 'lucide-react';
import { EXTERNAL_LINKS } from '@/app/constants/externalLinks';
import { ConnectButton } from '@/app/components/connectButton';

interface HeaderProps {
  onMenuClick: () => void;
}

export const Header = ({ onMenuClick }: HeaderProps) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsPopoverOpen(false);
      }
    };

    if (isPopoverOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isPopoverOpen]);

  const menuItems = [
    { label: 'Support', href: EXTERNAL_LINKS.CONTACT_SUPPORT },
    { label: 'Privacy Policy', href: EXTERNAL_LINKS.POLYGON_PRIVACY_POLICY },
    { label: 'Terms of Use', href: EXTERNAL_LINKS.POLYGON_TERMS_OF_USE },
  ];

  return (
    <div className="flex items-center justify-between py-2 px-4 border-b border-gray-200 bg-white">
      <div className="flex items-center gap-4">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 hover:bg-gray-100 rounded-md cursor-pointer"
          aria-label="Toggle menu"
        >
          <Menu size={20} />
        </button>
        <h1 className="text-2xl font-bold">Bridge Hub</h1>
      </div>
      <div className="flex gap-1 items-center relative">
        <ConnectButton />
        <div ref={popoverRef}>
          <button
            onClick={() => setIsPopoverOpen(!isPopoverOpen)}
            className="p-2 rounded-md border border-gray-300 hover:bg-gray-50 cursor-pointer"
          >
            <EllipsisVertical size={20} />
          </button>
          {isPopoverOpen && (
            <div className="absolute top-full right-0 mt-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
              <div className="py-1">
                {menuItems.map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
                    onClick={() => setIsPopoverOpen(false)}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
