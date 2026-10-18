"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiProgress } from "@/lib/ai/contracts";
import { describeProgress } from "@/lib/ai/client";

/** Elapsed-time and streamed-progress hint while an AI request is pending. */
export function useAiProgress(active: boolean) {
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [seconds, setSeconds] = useState(0);
  const started = useRef(0);
  useEffect(() => {
    if (!active) return;
    started.current = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started.current) / 1000)),
      1000,
    );
    return () => {
      clearInterval(timer);
      setSeconds(0);
      setProgress(null);
    };
  }, [active]);
  const onProgress = useCallback((p: AiProgress) => {
    // Each request starts with a local "waiting" event; restart the elapsed counter.
    if (p.stage === "waiting") {
      started.current = Date.now();
      setSeconds(0);
    }
    setProgress(p);
  }, []);
  return {
    onProgress,
    text: active ? describeProgress(progress, seconds) : "",
  };
}

export function AiProgressHint({ text }: { text: string }) {
  return text ? (
    <p className="form-hint" aria-live="polite" data-testid="ai-progress">
      {text}
    </p>
  ) : null;
}
