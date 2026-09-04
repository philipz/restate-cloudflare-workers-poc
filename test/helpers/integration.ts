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
// 限制（誠實記錄）：本 harness 模擬的是「應用層狀態機 + 單執行緒依序交錯」，
// 不模擬 Restate 執行期（持久化、重播、並行 exclusive 序列化、fire-and-forget 的 async 背景佇列）。
// 真正的並發互斥/重播語意屬需外部 Restate server 的 E2E 範疇（test-all.sh）。
import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject } from "../../src/game";
import { checkoutWorkflow } from "../../src/checkout";
import { gameManager } from "../../src/game_manager";
import { handlersOf, TerminalError } from "./mocks";

export { TerminalError };

export type HandlerFn = (ctx: unknown, ...args: unknown[]) => unknown;

/** 單一物件的狀態槽：data 為其 KV 儲存，sets/clears 記錄寫入動作。 */
export interface StateSlot {
  data: Record<string, unknown>;
  sets: Array<{ key: string; value: unknown }>;
  clears: string[];
}

/** 整個整合式測試的共享狀態：依 `${service}:${key}` 分區。 */
export interface WorldState {
  slots: Record<string, StateSlot>;
  runs: string[];
  /** 可覆寫的時鐘（毫秒）；未設時回 Date.now()。供 TTL 情境（S4）注入。 */
  now: () => number;
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
  };
  return world;
}

/** 依 handler 名稱產生一個會「實際執行真實 handler」的 client stub。 */
function realHandlerFn(
  world: WorldState,
  service: string,
  key: string,
  handler: HandlerFn
) {
  return async (...args: unknown[]) => {
    const ctx = makeRoutedCtx(world, service, key);
    return await handler(ctx, ...args);
  };
}

/** 建立 object/service client 通用 method recorder（每 method 一個真實執行閉包）。 */
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
      return realHandlerFn(world, service, key, handler);
    },
  });
}

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
      world.runs.push(`${service}.${label}`);
      if (label === "now") {
        return world.now();
      }
      return await fn();
    },
    objectClient: (def: { name: string }, k: string) => {
      const handlers = handlersOf<Record<string, HandlerFn>>(def, "object");
      return realClient(world, def.name, k, handlers);
    },
    objectSendClient: (def: { name: string }, k: string) => {
      const handlers = handlersOf<Record<string, HandlerFn>>(def, "object");
      // fire-and-forget：本 harness 以「同步執行」逼近（單執行緒依序交錯），
      // 以便 S6 的全員釋放能被觀察到。真正的 async 背景佇列不在此模擬。
      return realClient(world, def.name, k, handlers);
    },
    serviceSendClient: (def: { name: string }) => {
      const handlers = handlersOf<Record<string, HandlerFn>>(def, "service");
      return realClient(world, def.name, "", handlers);
    },
  };
  return ctx as unknown as restate.Context;
}

export interface IntegrationWorld {
  world: WorldState;
  /** 依 key 取得 Ticket 物件的真實 handler 集合。 */
  ticket: (key: string) => Record<string, (arg?: unknown) => unknown>;
  /** SeatMap 物件（global）的真實 handler 集合。 */
  seatMap: Record<string, (arg?: unknown) => unknown>;
  /** Checkout service 的真實 handler 集合。 */
  checkout: Record<string, (arg?: unknown) => unknown>;
  /** GameManager service 的真實 handler 集合。 */
  manager: Record<string, (arg?: unknown) => unknown>;
  /** 直接讀取某物件槽位的狀態（斷言用）。 */
  stateOf: (service: string, key: string) => StateSlot;
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
 * 狀態共享。`ctx.run("now")` 讀取 world.now()（可受控），其餘 run 閉包照常執行。
 */
export function createIntegration(initialNow?: number): IntegrationWorld {
  const world = createWorld(initialNow);

  const ticket = (key: string): Record<string, (arg?: unknown) => unknown> => {
    const handlers = ticketHandlers();
    const out: Record<string, (arg?: unknown) => unknown> = {};
    for (const name of Object.keys(handlers)) {
      out[name] = (arg?: unknown) => handlers[name](makeRoutedCtx(world, "Ticket", key), arg);
    }
    return out;
  };

  const mkObject = (
    handlers: Record<string, HandlerFn>,
    service: string,
    key: string
  ): Record<string, (arg?: unknown) => unknown> => {
    const out: Record<string, (arg?: unknown) => unknown> = {};
    for (const name of Object.keys(handlers)) {
      out[name] = (arg?: unknown) => handlers[name](makeRoutedCtx(world, service, key), arg);
    }
    return out;
  };

  const seatMap = mkObject(seatMapHandlers(), "SeatMap", "global");
  const checkout = mkObject(checkoutHandlers(), "Checkout", "");
  const manager = mkObject(managerHandlers(), "GameManager", "");

  return {
    world,
    ticket,
    seatMap,
    checkout,
    manager,
    stateOf: (service, key) => slotOf(world, service, key),
  };
}
