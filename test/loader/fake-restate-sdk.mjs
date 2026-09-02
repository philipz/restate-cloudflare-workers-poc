// 測試用 Restate SDK 鏡像stub。
//
// 為什麼需要：@restatedev/restate-sdk-cloudflare-workers 在模組載入期 import
// `sdk_shared_core_wasm_bindings_bg.wasm`（default export），這只有在
// wrangler/workerd（ bundler）環境可用；純 Node 無法載入。本 stub 依實際
// SDK dist（types/rpc.js，v1.9.1）逐字鏡像 src/ 唯一用到的四個匯出的
// 結構語義，讓單元測試能直接執行 repo 自己的 handler 邏輯：
//   - service(def) -> { name, service: {...handler 原函式副本} }
//   - object(def)  -> { name, object: {...handler 原函式副本} }
//   - TerminalError extends Error（帶可選 errorCode）
//   - createEndpointHandler(opts) -> (request, env, ctx) => Promise<Response>
//
// 注意：這裡不模擬 Restate 執行期（持久化/重試/serde 管線），那些屬於
// 需要外部 Restate server 的 E2E 範疇（見 test-all.sh，本工作項依 DoD 不跑）。
// createEndpointHandler 回傳「記錄用」handler：被呼叫時記到
// globalThis.__restateEndpointCalls 並回 599 標記回應，讓 fetch 路由測試能
// 斷言「非 mock-payment 路徑交給 restate endpoint 處理」——斷言的是
// src/index.ts 自己的路由行為，不是 restate 內部。

const HANDLER_SYMBOL = Symbol.for("restate.handler");

function wrapHandlers(kind, handlers) {
  const out = {};
  for (const [name, handler] of Object.entries(handlers ?? {})) {
    if (typeof handler !== "function") {
      throw new TypeError(`Unexpected handler type ${name}`);
    }
    // 與實際 SDK 相同：建立原函式副本，並掛上 HANDLER_SYMBOL 標記。
    const copy = function (...args) {
      return handler.apply(this, args);
    };
    Object.defineProperty(copy, HANDLER_SYMBOL, { value: { kind } });
    out[name] = copy;
  }
  return out;
}

export function service(def) {
  if (!def || !def.handlers) {
    throw new Error("service must be defined");
  }
  return {
    name: def.name,
    service: wrapHandlers("service", def.handlers),
    metadata: def.metadata,
    description: def.description,
    options: def.options,
  };
}

export function object(def) {
  if (!def || !def.handlers) {
    throw new Error("object options must be defined");
  }
  return {
    name: def.name,
    object: wrapHandlers("exclusive", def.handlers),
    metadata: def.metadata,
    description: def.description,
    options: def.options,
  };
}

export class TerminalError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "TerminalError";
    if (options && typeof options.errorCode === "number") {
      this.errorCode = options.errorCode;
    }
  }
}

export function createEndpointHandler() {
  return async function handler(request) {
    const calls = (globalThis.__restateEndpointCalls ??= []);
    calls.push({ url: request.url, method: request.method });
    return new Response("FAKE-RESTATE-ENDPOINT", { status: 599 });
  };
}

export default {
  service,
  object,
  TerminalError,
  createEndpointHandler,
};
