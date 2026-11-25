import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

/** Keeps the split between MIN_RATIO and MAX_RATIO; falls back on NaN. */
export function clampRatio(ratio: number, fallback = 0.65): number {
  if (!Number.isFinite(ratio)) return fallback;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function readStored(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : clampRatio(Number(raw), fallback);
  } catch {
    return fallback;
  }
}

/**
 * Vertical splitter: `ratio` is the share of the container given to the
 * top pane. Drag with the pointer or use ArrowUp / ArrowDown on the handle.
 */
export function useSplit(storageKey: string, initial = 0.65) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(() => readStored(storageKey, initial));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(ratio));
    } catch {
      // storage unavailable: the split just isn't remembered
    }
  }, [storageKey, ratio]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      setRatio(clampRatio((e.clientY - rect.top) / rect.height));
    },
    [dragging],
  );

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRatio((r) => clampRatio(r - 0.03));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRatio((r) => clampRatio(r + 0.03));
    }
  }, []);

  return {
    containerRef,
    ratio,
    dragging,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown },
  };
}
