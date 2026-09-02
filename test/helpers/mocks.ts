// 測試用 Restate context 模擬器與定義存取 helper。
//
// 依賴說明：`@restatedev/restate-sdk-cloudflare-workers/fetch` 在測試執行期
// 由 test/loader/ 的 Node loader hooks 導向鏡像 stub（見該目錄註解），
// 因此這裡可以同時取得「與 src 相同模組來源」的 TerminalError（instanceof 成立）
// 與 restate 命名空间的型別（來自實際 SDK 的 .d.ts，供 tsc 型別檢查）。
import { TerminalError } from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import type * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";

export { TerminalError };

export interface RecordedCall {
  service: string;
  key: string;
  handler: string;
  args: unknown[];
}

type HandlerFn = (...args: unknown[]) => unknown;
/** 依 service 名稱 → handler 名稱 注入自訂實作（例如讓 reserve 拋錯）。 */
export type ClientOverrides = Record<string, Record<string, HandlerFn>>;

export interface MockState {
  /** KV 狀態儲存（ctx.get/set/clear 的後盾）。 */
  data: Record<string, unknown>;
  sets: Array<{ key: string; value: unknown }>;
  clears: string[];
  runs: string[];
  /** 經 ctx.objectClient() 發出的（同步等待型）呼叫。 */
  objectCalls: RecordedCall[];
  /** 經 ctx.objectSendClient()/serviceSendClient() 發出的（fire-and-forget）呼叫。 */
  sendCalls: RecordedCall[];
}

export function createMockState(initial: Record<string, unknown> = {}): MockState {
  return { data: { ...initial }, sets: [], clears: [], runs: [], objectCalls: [], sendCalls: [] };
}

function recorder(
  sink: RecordedCall[],
  service: string,
  key: string,
  overrides?: Record<string, HandlerFn>
) {
  return new Proxy({} as Record<string, HandlerFn>, {
    get(_target, prop) {
      const name = String(prop);
      return async (...args: unknown[]) => {
        sink.push({ service, key, handler: name, args });
        const override = overrides?.[name];
        if (override) {
          return await override(args);
        }
        return undefined;
      };
    },
  });
}

/**
 * 建立足以驅動 src/ 各 handler 的 mock Context：
 * get/set/clear/run/objectClient/objectSendClient/serviceSendClient。
 * 未注入 override 的遠端呼叫一律記錄並回傳 undefined（POC 的 src 不讀其回傳值）。
 */
export function createMockContext(
  mock: MockState,
  options: { overrides?: ClientOverrides; sendOverrides?: ClientOverrides } = {}
): restate.Context {
  const ctx = {
    get: async (key: string) => {
      const value = mock.data[key];
      return value === undefined ? null : value;
    },
    set: (key: string, value: unknown) => {
      mock.data[key] = value;
      mock.sets.push({ key, value });
    },
    clear: (key: string) => {
      delete mock.data[key];
      mock.clears.push(key);
    },
    run: async (label: string, fn: () => unknown) => {
      mock.runs.push(label);
      return await fn();
    },
    objectClient: (def: { name: string }, key: string) =>
      recorder(mock.objectCalls, def.name, key, options.overrides?.[def.name]),
    objectSendClient: (def: { name: string }, key: string) =>
      recorder(mock.sendCalls, def.name, key, options.sendOverrides?.[def.name]),
    serviceSendClient: (def: { name: string }) =>
      recorder(mock.sendCalls, def.name, "", options.sendOverrides?.[def.name]),
  };
  return ctx as unknown as restate.Context;
}

/**
 * 取得 service()/object() 定義中的原始 handler 集合。
 * 欄位形狀（def.service / def.object，值為原 handler 函式副本）係對照
 * 實際 SDK dist/types/rpc.js v1.9.1 的 service()/object() 實作驗證。
 */
export function handlersOf<T>(def: unknown, field: "service" | "object"): T {
  const value = (def as Record<string, unknown>)[field];
  if (!value) {
    throw new Error(`definition is missing "${field}" handlers (SDK shape changed?)`);
  }
  return value as T;
}
