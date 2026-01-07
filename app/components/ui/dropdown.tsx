'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/app/utils/common';

export type DropdownOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
};

type DropdownProps = {
  options: DropdownOption[];
  selectedValue?: string;
  onSelectAction: (option: DropdownOption) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
};

export const Dropdown = ({
  options,
  selectedValue,
  onSelectAction,
  placeholder = 'Select',
  label,
  disabled,
  className,
}: DropdownProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === selectedValue),
    [options, selectedValue],
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div className={cn('relative flex flex-col gap-2', className)} ref={containerRef}>
      {label && <span className="text-sm font-medium text-muted">{label}</span>}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2 shadow-xs transition cursor-pointer',
          disabled
            ? 'cursor-not-allowed bg-surface-muted opacity-70'
            : 'hover:border-slate-300 focus-visible:outline-none',
        )}
      >
        <span className="flex items-center gap-2 text-sm">
          {selected?.icon}
          <span className={cn(selected ? 'text-black' : 'text-grey')}>
            {selected?.label ?? placeholder}
          </span>
        </span>
        <ChevronDown size={16} className={cn('text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-full rounded-xl border border-border bg-surface  overflow-hidden">
          <div className="py-1 max-h-64 overflow-y-auto">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onSelectAction(option);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-muted transition-colors cursor-pointer',
                  selectedValue === option.value && 'bg-surface-muted',
                )}
              >
                {option.icon}
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-black">{option.label}</span>
                  {option.description && (
                    <span className="text-xs text-grey">{option.description}</span>
                  )}
                </div>
              </button>
            ))}
            {options.length === 0 && (
              <div className="px-3 py-2 text-sm text-grey">No options available</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
