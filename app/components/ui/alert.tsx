import type { LucideIcon } from 'lucide-react';

import { cn } from '@/app/utils/common';
import { TriangleAlert, Info } from 'lucide-react';

interface AlertProps {
  title: string;
  message: string;
  type?: 'warning' | 'danger' | 'info';
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({ title, message, type = 'warning', className }) => {
  const typeToClasses: Record<string, string> = {
    warning: 'bg-orange-light text-black',
    danger: 'bg-red-light text-black',
    info: 'bg-grey-light text-black'
  };

  const typeToIcon: Record<string, LucideIcon> = {
    warning: TriangleAlert,
    danger: TriangleAlert,
    info: Info
  };

  const Icon = typeToIcon[type];

  return (
    <div className={cn(typeToClasses[type], 'p-3 rounded-xl flex gap-2', className)}>
      <Icon className={cn('size-5 shrink-0', type === 'warning' ? 'text-orange' : '')} />
      <div className="flex flex-col text-sm">
        <span className="font-semibold">{title}</span>
        <span>{message}</span>
      </div>
    </div>
  );
};
