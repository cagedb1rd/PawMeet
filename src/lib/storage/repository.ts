import { createSeed } from "@/data/seed";
import { Command, execute } from "@/domain/commands";
import { DemoState, stateSchema } from "@/domain/schemas";
import { stateSchema as legacySchema } from "@/domain/legacy-schema";

export const STATE_KEY = "pawmeet:state:v1";
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export class StorageProblem extends Error {
  constructor(
    message: string,
    public raw: string | null = null,
  ) {
    super(message);
  }
}
export function readState(store: KeyValueStore): DemoState {
  let raw: string | null;
  try {
    raw = store.getItem(STATE_KEY);
  } catch {
    throw new StorageProblem(
      "浏览器不允许读取本地数据，请检查隐私或存储设置。",
    );
  }
  if (raw === null) {
    const state = createSeed();
    writeState(store, state);
    return state;
  }
  try {
    const value = JSON.parse(raw);
    if (value?.schemaVersion === 1) {
      const old = legacySchema.parse(value);
      // Pure migration: persist only on the next successful, locked command.
      return stateSchema.parse({
        ...old,
        schemaVersion: 2,
        helpRequests: old.helpRequests.map((h) => ({
          ...h,
          helperId: null,
          acceptedApplicationId: null,
          contentRevision: 1,
          details:
            h.details === "虚构需求预览，互助申请与交接流程将在 Phase 2 开放。"
              ? "虚构演示需求，请与主人核对照看习惯与交接清单。"
              : h.details,
        })),
      });
    }
    return stateSchema.parse(value);
  } catch {
    throw new StorageProblem(
      "本地数据损坏或版本不受支持，原始内容已保留。请先导出备份，或明确重置。",
      raw,
    );
  }
}
export function writeState(store: KeyValueStore, state: DemoState) {
  const raw = JSON.stringify(stateSchema.parse(state));
  if (raw.length * 2 > MAX_STATE_BYTES)
    throw new StorageProblem("结构化数据超过 2MiB，请重置演示数据后再试。");
  try {
    store.setItem(STATE_KEY, raw);
  } catch {
    throw new StorageProblem(
      "保存失败：本地存储空间不足或被浏览器禁用。更改尚未保存，请保留表单后重试。",
    );
  }
}
export function commit(
  store: KeyValueStore,
  previous: DemoState,
  command: Command,
): DemoState {
  if (store.getItem(STATE_KEY) === null)
    throw new StorageProblem("本地数据已被清除，请刷新后再操作。");
  const latest = readState(store);
  if (JSON.stringify(latest) !== JSON.stringify(previous))
    throw new StorageProblem("数据已被其他页面修改，请刷新后再操作。");
  const next = execute(latest, command);
  writeState(store, next);
  return next;
}
