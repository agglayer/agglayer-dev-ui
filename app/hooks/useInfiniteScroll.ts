import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

interface UseInfiniteScrollOptions {
  sentinelRef: RefObject<Element | null>;
  onIntersect: () => void;
  enabled?: boolean;
  threshold?: number | number[];
  rootMargin?: string;
  rootRef?: RefObject<Element | null>;
}

export const useInfiniteScroll = ({
  sentinelRef,
  onIntersect,
  enabled = true,
  threshold = 0,
  rootMargin = '0px',
  rootRef,
}: UseInfiniteScrollOptions) => {
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const initialCheckDoneRef = useRef(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = rootRef?.current ?? null;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) return;
        if (!enabledRef.current) return;

        onIntersect();
      },
      {
        root,
        threshold,
        rootMargin,
      },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [sentinelRef, rootRef, onIntersect, threshold, rootMargin]);

  // Handles case for short lists when end is already in view
  useEffect(() => {
    if (!enabled || initialCheckDoneRef.current) return;

    const sentinel = sentinelRef.current;
    const root = rootRef?.current ?? null;
    if (!sentinel) return;

    const rect = sentinel.getBoundingClientRect();
    const inView = root
      ? (() => {
          const rootRect = root.getBoundingClientRect();
          return rect.top < rootRect.top + root.clientHeight && rect.bottom >= rootRect.top;
        })()
      : rect.top < window.innerHeight && rect.bottom >= 0;

    if (inView) {
      onIntersect();
    }

    initialCheckDoneRef.current = true;
  }, [enabled, onIntersect, sentinelRef, rootRef]);
};
