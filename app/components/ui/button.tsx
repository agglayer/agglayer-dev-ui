import { cn } from "@/app/utils/common";

interface ButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'outline' | 'ghost';
}

const SIZE_STYLES = {
  sm: 'py-1.5 px-3 text-sm',
  md: 'py-2.5 px-4 text-base',
  lg: 'py-3 px-6 text-lg',
};

const VARIANT_STYLES = {
  primary: 'bg-primary text-white hover:brightness-110',
  outline: 'bg-transparent border border-border text-black hover:border-blue hover:bg-surface-muted',
  ghost: 'bg-transparent text-black hover:bg-surface-muted',
};

export const Button: React.FC<ButtonProps> = ({
  onClick,
  disabled,
  className,
  children,
  size = 'md',
  variant = 'primary',
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-xl font-semibold shadow-xs transition inline-flex items-center gap-2 justify-center',
        SIZE_STYLES[size],
        VARIANT_STYLES[variant],
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
    >
      {children}
    </button>
  );
}
