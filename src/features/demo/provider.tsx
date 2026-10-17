"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { DemoState } from "@/domain/schemas";
import { Command } from "@/domain/commands";
import {
  commit,
  readState,
  STATE_KEY,
  StorageProblem,
  writeState,
} from "@/lib/storage/repository";
import { createSeed } from "@/data/seed";
import { cleanUnusedImages, clearImages } from "@/lib/storage/images";

type Context = {
  state: DemoState | null;
  writable: boolean;
  problem: string;
  raw: string | null;
  notice: string;
  run: (c: Command) => boolean;
  reset: () => Promise<boolean>;
  notify: (s: string) => void;
  clean: () => Promise<void>;
};
const DemoContext = createContext<Context | null>(null);
export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DemoState | null>(null),
    current = useRef<DemoState | null>(null);
  const [writable, setWritable] = useState(false),
    [problem, setProblem] = useState(""),
    [raw, setRaw] = useState<string | null>(null),
    [notice, notify] = useState("");
  useEffect(() => {
    let mounted = true,
      release: (() => void) | undefined;
    const load = (canWrite: boolean) => {
      if (!mounted) return;
      setWritable(canWrite);
      try {
        if (!canWrite && localStorage.getItem(STATE_KEY) === null) {
          setProblem("另一个页面正在初始化数据，请稍后刷新。");
          return;
        }
        const s = readState(localStorage);
        current.current = s;
        setState(s);
      } catch (e) {
        setProblem(e instanceof Error ? e.message : "读取失败");
        if (e instanceof StorageProblem) setRaw(e.raw);
      }
    };
    if (navigator.locks) {
      void navigator.locks
        .request("pawmeet-writer-v1", { ifAvailable: true }, async (lock) => {
          load(!!lock);
          if (lock && mounted)
            await new Promise<void>((r) => {
              release = r;
            });
        })
        .catch(() => {
          if (mounted) {
            load(false);
          }
        });
    } else load(false);
    const external = (e: StorageEvent) => {
      if (e.key === STATE_KEY || e.key === null) {
        setWritable(false);
        notify("本地数据已在其他页面变更，请刷新以读取最新数据。");
      }
    };
    window.addEventListener("storage", external);
    return () => {
      mounted = false;
      release?.();
      window.removeEventListener("storage", external);
    };
  }, []);
  const run = useCallback(
    (c: Command) => {
      if (!writable || !current.current) {
        notify("当前页面不可写，请关闭其他标签页并刷新");
        return false;
      }
      try {
        const next = commit(localStorage, current.current, c);
        current.current = next;
        setState(next);
        return true;
      } catch (e) {
        notify(e instanceof Error ? e.message : "保存失败");
        return false;
      }
    },
    [writable],
  );
  const reset = async () => {
    if (!writable) {
      notify("只读模式不能重置");
      return false;
    }
    try {
      const s = createSeed();
      writeState(localStorage, s);
      current.current = s;
      setState(s);
      setProblem("");
      setRaw(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : "重置失败");
      return false;
    }
    try {
      await clearImages();
      notify("演示数据已重置，上传照片已清除");
    } catch {
      notify("数据已重置，但旧照片清理失败。请点击“清理未引用照片”重试");
    }
    return true;
  };
  const clean = async () => {
    if (!writable || !current.current) return;
    try {
      await cleanUnusedImages(current.current);
      notify("未引用的上传照片已清理");
    } catch (e) {
      notify(e instanceof Error ? e.message : "清理失败");
    }
  };
  return (
    <DemoContext.Provider
      value={{
        state,
        writable,
        problem,
        raw,
        notice,
        run,
        reset,
        notify,
        clean,
      }}
    >
      {children}
    </DemoContext.Provider>
  );
}
export function useDemo() {
  const c = useContext(DemoContext);
  if (!c) throw new Error("DemoProvider missing");
  return c;
}
