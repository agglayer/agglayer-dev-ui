'use client';

import { useEffect } from 'react';

type RefList = Array<React.RefObject<HTMLElement | null>>;

export const useClickOutside = (refs: RefList, handler: () => void, enabled = true) => {
  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = ({ target }: PointerEvent) => {
      const isInside = target instanceof Node && refs.some(({ current }) => current?.contains(target));
      if (!isInside) {
        handler();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [refs, handler, enabled]);
};
