import React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/app/utils/common';

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  label?: React.ReactNode;
  labelClassName?: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({
  checked,
  onCheckedChange,
  disabled,
  className,
  label,
  labelClassName,
}) => {
  const handleChange = () => {
    if (!disabled) {
      onCheckedChange(!checked);
    }
  };

  return (
    <label className={cn('flex items-start gap-2', !disabled && 'cursor-pointer', className)}>
      <div className="relative shrink-0">
        <input type="checkbox" checked={checked} onChange={handleChange} disabled={disabled} className="sr-only" />
        <div
          className={cn(
            'size-4 rounded border-2 flex items-center justify-center transition-colors mt-1',
            checked ? 'bg-blue border-blue' : 'bg-white border-grey',
            !disabled && 'cursor-pointer',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          {checked && <Check className="size-3 text-white stroke-4" />}
        </div>
      </div>
      {label && <span className={cn('text-sm', labelClassName)}>{label}</span>}
    </label>
  );
};
