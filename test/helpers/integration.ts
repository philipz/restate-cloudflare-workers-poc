// 整合式測試 harness：把 src/ 各 Virtual Object / Service 的「真實 handler」互相接線，
// 以共享的 KV 狀態儲存（依 (service, key) 分區）驅動，取代 recorder stub 的
// 「未 override 一律回 undefined」替身，讓測試能對「真實 handler 互接」的既有行為做斷言。
//
// 與 helpers/mocks.ts 的差別：
// - mocks.ts 的 objectClient 只「記錄呼叫」並回 undefined（或注入單點 override）；
//   適合單一 handler 的順序/補償測試（見 checkout.test.ts）。
// - 本 harness 的 objectClient 會「實際呼叫」該服務該 key 的真實 handler，
//   狀態跨 handler 共享、可被後續讀取——適合 Scenario S1–S6 這類
//   「跨物件、跨 handler 的競態/一致性情境」整合測試。
//
// Issue #20 保真度升級（四件能力，自我驗證見 test/harness_fidelity.test.ts）：
// ① per-(service,key) 非同步互斥：同一物件槽的 handler 執行依先進先出序列化，
//    逼近 Restate Virtual Object 的 exclusive 語意——不再產生
//    「併發 reserve 都看到 AVAILABLE」這種生產不可能的交錯（誤報假 bug 的來源）。
// ② fire-and-forget 延遲投遞：objectSendClient/serviceSendClient 的呼叫進入
//    world.pendingSends 佇列（不再同步執行），由 deliver(n)/drain() 控制投遞，
//    讓「投遞延遲視窗」成為可斷言的觀察對象（舊版無法表達，S3 自承重現不了）。
// ③ ctx.run 插隊控制點：world.hooks.before/after 會在每個 run 邊界（含 "now"）
//    依序觸發且被 await——測試可在「付款完成、confirm 之前」等精確時點注入交錯。
// ④ 呼叫軌跡：world.calls 以 mocks.ts 的 RecordedCall 形狀記錄每次真實 handler
//    執行（服務入口／跨物件 client／延遲投遞），投遞「前」不在軌跡中。
//
// 限制（誠實記錄）：本 harness 模擬「應用層狀態機＋單執行緒序列化交錯」，
// 不模擬 Restate 執行期的持久化／重播／多機器真並行。
// 已知約束：同一 handler 執行中若（經 hook 或嵌套 objectClient）再呼叫「自己所在
// 槽位」的 handler，會因互斥排隊在自身之後而死鎖——src/ 現況無此形狀；跨槽互等
// 亦同（A 持鎖 await B、B await A）。真正的並發語意屬需外部 Restate server 的
// E2E 範疇（test-all.sh）。
import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject } from "../../src/game";
import { checkoutWorkflow } from "../../src/checkout";
import { gameManager } from "../../src/game_manager";
import { handlersOf, TerminalError } from "./mocks";
import type { RecordedCall } from "./mocks";

export { TerminalError };
export type { RecordedCall };

export type HandlerFn = (ctx: unknown, ...args: unknown[]) => unknown;

/** 單一物件的狀態槽：data 為其 KV 儲存，sets/clears 記錄寫入動作。 */
export interface StateSlot {
  data: Record<string, unknown>;
  sets: Array<{ key: string; value: unknown }>;
  clears: string[];
}

/** 一筆尚未投遞的 fire-and-forget 呼叫（②：service/key/handler/args 沿用 RecordedCall 形狀）。 */
export interface PendingSend {
  kind: "object" | "service";
  service: string;
  key: string;
  handler: string;
  args: unknown[];
  /** 待投遞的真實 handler（入隊時已解析，投遞時直接執行）。 */
  fn: HandlerFn;
}

/** ctx.run 控制點 hook（③）：於每個 run 邊界以 (label, service, key) 觸發，可非同步。 */
export type RunHook = (label: string, service: string, key: string) => void | Promise<void>;

/** 整個整合式測試的共享狀態：依 `${service}:${key}` 分區。 */
export interface WorldState {
  slots: Record<string, StateSlot>;
  runs: string[];
  /** 可覆寫的時鐘（毫秒）；未設時回 Date.now()。供 TTL 情境（S4）注入。 */
  now: () => number;
  /** ④ 呼叫軌跡：每次「真實 handler 執行」按序記錄（投遞中的 send 於執行時才進軌跡）。 */
  calls: RecordedCall[];
  /** ② fire-and-forget 待投遞佇列（FIFO）。 */
  pendingSends: PendingSend[];
  /** ② 投遞時 handler 拋出的異常隔離記錄於此（不外溢成 unhandled rejection）。 */
  deliveryErrors: unknown[];
  /** ③ ctx.run 插隊控制點（未設時行為與升級前一致）。 */
  hooks: { before?: RunHook; after?: RunHook };
  /** ① per-slot 互斥等待鏈：值為「該槽目前排隊中之最後一個執行的完成信號」。 */
  locks: Map<string, Promise<void>>;
}

function slotKey(service: string, key: string): string {
  return `${service}:${key}`;
}

export function slotOf(world: WorldState, service: string, key: string): StateSlot {
  const k = slotKey(service, key);
  let slot = world.slots[k];
  if (!slot) {
    slot = { data: {}, sets: [], clears: [] };
    world.slots[k] = slot;
  }
  return slot;
}

export function createWorld(initialNow?: number): WorldState {
  const world: WorldState = {
    slots: {},
    runs: [],
    now: initialNow === undefined ? () => Date.now() : () => initialNow,
    calls: [],
    pendingSends: [],
    deliveryErrors: [],
    hooks: {},
    locks: new Map(),
  };
  return world;
}

/**
 * ① 把一個執行排進某 (service,key) 槽的互斥鏈尾端（FIFO 序列化）。
 * 鏈本身只追蹤「完成」、吞掉成敗——handler 拋錯不會卡死後續排隊者。
 */
function enqueueOnSlot<T>(
  world: WorldState,
  service: string,
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const k = slotKey(service, key);
  const prev = world.locks.get(k) ?? Promise.resolve();
  const settled = prev.then(task, task);
  world.locks.set(
    k,
    settled.then(
      () => undefined,
      () => undefined
    )
  );
  return settled;
}

/** 執行一個「物件槽上的真實 handler」：先取得該槽互斥鎖，再記錄呼叫軌跡後執行。 */
function executeObjectHandler(
  world: WorldState,
  service: string,
  key: string,
  name: string,
  handler: HandlerFn,
  args: unknown[]
): Promise<unknown> {
  return enqueueOnSlot(world, service, key, async () => {
    world.calls.push({ service, key, handler: name, args });
    const ctx = makeRoutedCtx(world, service, key);
    return await handler(ctx, ...args);
  });
}

/** 執行一個「服務 handler」：Restate service 無 per-key exclusive，不取鎖，但仍記錄軌跡。 */
function executeServiceHandler(
  world: WorldState,
  service: string,
  name: string,
  handler: HandlerFn,
  args: unknown[]
): Promise<unknown> {
  world.calls.push({ service, key: "", handler: name, args });
  const ctx = makeRoutedCtx(world, service, "");
  return Promise.resolve().then(() => handler(ctx, ...args));
}

/**
 * 建立 object client 通用 method recorder（同步等待型）：每 method 一個
 * 「經 ① 互斥＋④ 軌跡、實際執行真實 handler」的閉包。
 */
function realClient(
  world: WorldState,
  service: string,
  key: string,
  handlers: Record<string, HandlerFn>
) {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_target, prop) {
      const name = String(prop);
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`unknown handler "${name}" on ${service} (key=${key})`);
      }
      return async (...args: unknown[]) =>
        await executeObjectHandler(world, service, key, name, handler, args);
    },
  });
}

/**
 * ② 建立 send client（fire-and-forget）：呼叫只解析 handler 並進 pending 佇列，
 * 立即返回——真正的執行推遲到 deliver(n)/drain()。投遞延遲視窗因此可觀察、可斷言。
 */
function sendClient(
  world: WorldState,
  kind: "object" | "service",
  service: string,
  key: string,
  handlers: Record<string, HandlerFn>
) {
  return new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_target, prop) {
      const name = String(prop);
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`unknown handler "${name}" on ${service} (key=${key})`);
      }
      return async (...args: unknown[]) => {
        world.pendingSends.push({ kind, service, key, handler: name, args, fn: handler });
        return undefined;
      };
    },
  });
}

/** 投遞一筆 pending send（object 型走該槽互斥；service 型直接執行）。 */
function deliverPending(world: WorldState, s: PendingSend): Promise<unknown> {
  return s.kind === "object"
    ? executeObjectHandler(world, s.service, s.key, s.handler, s.fn, s.args)
    : executeServiceHandler(world, s.service, s.handler, s.fn, s.args);
}

/** 病理自排（handler 一直 queue 自己）時避免無限投遞的保險絲。 */
const MAX_DELIVERIES = 10_000;

/** 建立某 (service, key) 的 mock context，讀寫該槽位。run("now") 讀受控時鐘。 */
function makeRoutedCtx(world: WorldState, service: string, key: string): restate.Context {
  const ctx = {
    get: async (k: string) => {
      const slot = slotOf(world, service, key);
      const value = slot.data[k];
      return value === undefined ? null : value;
    },
    set: (k: string, value: unknown) => {
      const slot = slotOf(world, service, key);
      slot.data[k] = value;
      slot.sets.push({ key: k, value });
    },
    clear: (k: string) => {
      const slot = slotOf(world, service, key);
      delete slot.data[k];
      slot.clears.push(k);
    },
    run: async (label: string, fn: () => unknown) => {
      // ③ 插隊控制點：before/after 依序觸發且被 await（after 完成的下一個語句才是
      // handler 的繼續執行點）；未設 hook 時行為與升級前一致。
      const before = world.hooks.before;
      if (before) {
        await before(label, service, key);
      }
      world.runs.push(`${service}.${label}`);
      const result = label === "now" ? world.now() : await fn();
      const after = world.hooks.after;
      if (after) {
        await after(label, service, key);
      }
      return result;
    },
    objectClient: (def: { name: string }, k: string) => {
      const handlers = handlersOf<Record<string, HandlerFn>>(def, "object");
      return realClient(world, def.name, k, handlers);
    },
    objectSendClient: (def: { name: string }, k: string) => {
      const handlers = handlersOf<Record<string, HandlerFn>>(def, "object");
      // ② fire-and-forget：進 pending queue，由 deliver()/drain() 決定投遞時機。
      // （舊版為「同步執行」逼近，無法表達投遞視窗，故 S6 升級後需顯式 drain。）
      return sendClient(world, "object", def.name, k, handlers);
    },
    serviceSendClient: (def: { name: string }) => {
      const handlers = handlersOf<Record<string, HandlerFn>>(def, "service");
      return sendClient(world, "service", def.name, "", handlers);
    },
  };
  return ctx as unknown as restate.Context;
}

export interface IntegrationWorld {
  world: WorldState;
  /** 依 key 取得 Ticket 物件的真實 handler 集合（經 ① 互斥序列化）。 */
  ticket: (key: string) => Record<string, (arg?: unknown) => Promise<unknown>>;
  /** SeatMap 物件（global）的真實 handler 集合。 */
  seatMap: Record<string, (arg?: unknown) => Promise<unknown>>;
  /** Checkout service 的真實 handler 集合。 */
  checkout: Record<string, (arg?: unknown) => Promise<unknown>>;
  /** GameManager service 的真實 handler 集合。 */
  manager: Record<string, (arg?: unknown) => Promise<unknown>>;
  /** 直接讀取某物件槽位的狀態（斷言用）。 */
  stateOf: (service: string, key: string) => StateSlot;
  /** ② 依 FIFO 至多投遞 n 筆 pending send（含投遞期間新進隊者，排隊於其後）。 */
  deliver: (n: number) => Promise<void>;
  /** ② 投遞全部 pending（含投遞期間新進隊者）直到佇列清空。 */
  drain: () => Promise<void>;
}

/** 取得 service/object 定義的原始 handler 集合（沿用 mocks.ts 的 helpers）。 */
export { handlersOf };

export const ticketHandlers = () =>
  handlersOf<Record<string, HandlerFn>>(ticketObject, "object");
export const seatMapHandlers = () =>
  handlersOf<Record<string, HandlerFn>>(seatMapObject, "object");
export const checkoutHandlers = () =>
  handlersOf<Record<string, HandlerFn>>(checkoutWorkflow, "service");
export const managerHandlers = () =>
  handlersOf<Record<string, HandlerFn>>(gameManager, "service");

/**
 * 建立整合式世界：Ticket/SeatMap/GameManager/Checkout 接線到共享狀態。
 * 每個 handler 由其服務物件本身取得真實實作；跨物件呼叫會路由到真實 handler，
 * 狀態共享、per-key 互斥序列化。`ctx.run("now")` 讀取 world.now()（可受控），
 * 其餘 run 閉包照常執行；send client 進 pending queue 待 deliver()/drain() 投遞。
 */
export function createIntegration(initialNow?: number): IntegrationWorld {
  const world = createWorld(initialNow);

  /** 建立暴露入口：object 槽經 ① 互斥＋④ 軌跡；service 僅記錄軌跡。 */
  const mkEntry = (
    handlers: Record<string, HandlerFn>,
    service: string,
    key: string,
    kind: "object" | "service"
  ): Record<string, (arg?: unknown) => Promise<unknown>> => {
    const out: Record<string, (arg?: unknown) => Promise<unknown>> = {};
    for (const name of Object.keys(handlers)) {
      const handler = handlers[name];
      out[name] = (arg?: unknown) =>
        kind === "object"
          ? executeObjectHandler(world, service, key, name, handler, [arg])
          : executeServiceHandler(world, service, name, handler, [arg]);
    }
    return out;
  };

  const ticket = (key: string) => mkEntry(ticketHandlers(), "Ticket", key, "object");
  const seatMap = mkEntry(seatMapHandlers(), "SeatMap", "global", "object");
  const checkout = mkEntry(checkoutHandlers(), "Checkout", "", "service");
  const manager = mkEntry(managerHandlers(), "GameManager", "", "service");

  const deliver = async (n: number): Promise<void> => {
    let delivered = 0;
    while (delivered < n && world.pendingSends.length > 0) {
      if (delivered >= MAX_DELIVERIES) {
        throw new Error(`pending-send delivery exceeded ${MAX_DELIVERIES} items (runaway queue?)`);
      }
      const s = world.pendingSends.shift() as PendingSend;
      delivered++;
      try {
        await deliverPending(world, s);
      } catch (err) {
        world.deliveryErrors.push(err);
      }
    }
  };

  return {
    world,
    ticket,
    seatMap,
    checkout,
    manager,
    stateOf: (service, key) => slotOf(world, service, key),
    deliver,
    drain: () => deliver(Number.POSITIVE_INFINITY),
  };
}
