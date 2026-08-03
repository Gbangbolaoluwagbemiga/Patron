// motion.tsx — the small amount of movement The Ledger uses, in one place.
//
// The rule this file follows: motion earns its place by telling you something
// happened, or it doesn't ship. A number that ticks up tells you money moved. A
// row that lands tells you it is new. A pipeline node that fills tells you a
// stage completed. Decorative easing on things that didn't change is noise, and
// noise is what makes an interface feel generated.
//
// Everything here degrades to nothing under prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";
import type { Transition, Variants } from "framer-motion";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Ink settling on paper: quick, decisive, no bounce. */
export const inkTransition: Transition = { duration: 0.32, ease: [0.22, 0.61, 0.36, 1] };

/**
 * A ledger row arriving. Slight lift and fade only — no scale. Scale pops read
 * as app chrome; ink either is on the page or it isn't.
 */
export const rowVariants: Variants = {
  hidden: { opacity: 0, y: -6 },
  visible: { opacity: 1, y: 0, transition: inkTransition },
};

/** Page turn: the outgoing page lifts away, the incoming one settles in under it. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16, ease: "easeIn" } },
};

/**
 * Count a displayed number toward its real value.
 *
 * Used for money and for the running totals. The point is not decoration: when
 * an escrow releases, the "paid to humans" figure is the single most important
 * number on the site, and watching it climb is the difference between a judge
 * noticing the payment and missing it entirely.
 *
 * Only animates on CHANGE — the first value it ever sees is adopted instantly,
 * so a page load doesn't spend a second counting up from zero, which would look
 * like theatre rather than a live feed.
 */
export function useCountUp(target: number, durationMs = 850): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef<number | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true;
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    if (prefersReducedMotion() || fromRef.current === target) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic — fast to begin, settles rather than stops dead
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(step);
      else fromRef.current = target;
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      fromRef.current = target;
    };
  }, [target, durationMs]);

  return display;
}

/** True for a moment each time `value` changes — for one-shot emphasis on live updates. */
export function useFlashOnChange<T>(value: T, ms = 1400): boolean {
  const [flash, setFlash] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true;
      return;
    }
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);

  return flash;
}

/** Placeholder ruled lines, shown while the first fetch is in flight. */
export function LedgerSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton-line skeleton-line-sm" />
          <div className="skeleton-line skeleton-line-lg" />
          <div className="skeleton-line skeleton-line-md" />
        </div>
      ))}
    </div>
  );
}
