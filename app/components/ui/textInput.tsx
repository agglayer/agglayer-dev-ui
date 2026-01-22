'use client';

import { Search } from 'lucide-react';
import { cn } from '@/app/utils/common';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  isSearch?: boolean;
  className?: string;
  isError?: boolean;
}

export const TextInput = ({
  value,
  onChange,
  placeholder,
  label,
  disabled,
  isSearch,
  className,
  isError = false,
}: TextInputProps) => {
  return (
    <label className={cn('flex flex-col gap-2', disabled && 'opacity-60 cursor-not-allowed')}>
      {label && <span className="text-sm font-medium text-muted">{label}</span>}
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border bg-surface px-3 py-2 shadow-xs',
          disabled ? 'cursor-not-allowed bg-surface-muted' : 'hover:border-slate-300',
          isError ? 'border-red' : 'border-border',
          className,
        )}
      >
        {isSearch && <Search size={18} className="text-muted" />}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'w-full bg-transparent text-sm outline-none',
            'placeholder:text-grey',
            disabled && 'cursor-not-allowed',
          )}
        />
      </div>
    </label>
  );
};
