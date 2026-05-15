'use client';

import type { ReactNode } from 'react';

import { cn } from '@/app/utils/common';
import { ChevronDown, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

export type DropdownOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
};

interface DropdownProps {
  options: DropdownOption[];
  selectedValue?: string;
  onSelect: (option: DropdownOption) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  clearable?: boolean;
  onClear?: () => void;
}

export const Dropdown = ({
  options,
  selectedValue,
  onSelect,
  placeholder = 'Select',
  label,
  disabled,
  className,
  clearable = false,
  onClear
}: DropdownProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === selectedValue),
    [options, selectedValue]
  );
  const showClearButton = Boolean(clearable && selected && !disabled);

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
      <div
        className={cn(
          'flex items-center gap-2 rounded-xl border px-3 py-2 shadow-xs transition',
          selected && clearable
            ? 'border-blue bg-blue-subtle text-blue'
            : 'border-border bg-surface text-black',
          disabled ? 'cursor-not-allowed bg-surface-muted opacity-70' : 'hover:border-blue'
        )}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((prev) => !prev)}
          className="flex flex-1 items-center justify-between gap-3 text-left cursor-pointer"
        >
          <span className="flex items-center gap-2 text-sm">
            {selected?.icon}
            <span className={cn(selected ? 'text-black' : 'text-grey')}>
              {selected?.label ?? placeholder}
            </span>
          </span>
          {!showClearButton && (
            <ChevronDown
              size={16}
              className={cn('text-muted transition-transform cursor-pointer', open && 'rotate-180')}
            />
          )}
        </button>
        {showClearButton && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear?.();
            }}
            className="p-1 cursor-pointer rounded-full hover:bg-surface-muted text-grey"
            aria-label="Clear selection"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-20 mt-2 w-full rounded-xl border border-border bg-surface  overflow-hidden">
          <div className="py-1 max-h-64 overflow-y-auto">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onSelect(option);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-muted transition-colors cursor-pointer',
                  selectedValue === option.value && 'bg-surface-muted'
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
