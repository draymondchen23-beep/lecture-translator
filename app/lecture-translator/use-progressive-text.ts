"use client";

import { useEffect, useRef, useState } from "react";
import { advanceDisplayedText, codePointLength, progressiveDelay, reconcileDisplayedPrefix } from "./live-display.mjs";

type Options = {
  enabled?: boolean;
  initialText?: string;
  onComplete?: () => void;
};

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function useProgressiveText(target: string, options: Options = {}) {
  const enabled = options.enabled !== false;
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [displayed, setDisplayed] = useState(options.initialText || "");
  const displayedRef = useRef(displayed);
  const previousTargetRef = useRef(options.initialText || target);
  const onCompleteRef = useRef(options.onComplete);

  useEffect(() => {
    onCompleteRef.current = options.onComplete;
  }, [options.onComplete]);
  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const previousTarget = previousTargetRef.current;
    const start = enabled && !reducedMotion
      ? reconcileDisplayedPrefix(previousTarget, displayedRef.current, target)
      : target;
    previousTargetRef.current = target;
    displayedRef.current = start;
    setDisplayed(start);

    if (!enabled || reducedMotion || start === target) {
      if (enabled && start === target) onCompleteRef.current?.();
      return;
    }

    const tick = () => {
      const current = displayedRef.current;
      const nextTarget = target;
      const next = advanceDisplayedText(current, nextTarget);
      displayedRef.current = next;
      setDisplayed(next);
      if (next === nextTarget) {
        onCompleteRef.current?.();
        return;
      }
      timer = window.setTimeout(tick, progressiveDelay(codePointLength(nextTarget) - codePointLength(next)));
    };
    timer = window.setTimeout(tick, progressiveDelay(codePointLength(target) - codePointLength(start)));
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [target, enabled, reducedMotion]);

  return { displayed: enabled && !reducedMotion ? displayed : target, isAnimating: enabled && !reducedMotion && displayed !== target };
}
