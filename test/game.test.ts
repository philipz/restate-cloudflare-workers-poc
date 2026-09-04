// src/game.ts — TicketObject 虛擬物件狀態機單元測試。
// 透過 helpers/mocks 的鏡像 SDK 定義直接取得真實 handler 並注入 mock Context，
// 驗證票券 reserve/confirm/release/cleanup/get 的既有狀態轉移行為。
import { describe, it } from "node:test";
import { ticketObject } from "../src/game";
import type { TicketState } from "../src/game";
import { createMockContext, createMockState, handlersOf, TerminalError } from "./helpers/mocks";

type TicketHandler = (ctx: any, arg?: unknown) => Promise<unknown>;
const handlers = () => handlersOf<Record<string, TicketHandler>>(ticketObject, "object");

const DEFAULT_STATE: TicketState = {
  status: "AVAILABLE",
  reservedBy: null,
  reservedUntil: null,
};

function withState(state: Record<string, unknown> = {}) {
  const mock = createMockState(state);
  const ctx = createMockContext(mock);
  return { mock, ctx };
}

describe("Ticket.reserve()", () => {
  it("全新票券：AVAILABLE → RESERVED，寫入 state 並設 15 分鐘保留期", async (t) => {
    const { mock, ctx } = withState();
    const before = Date.now();
    const result = await handlers().reserve(ctx, "alice");
    const state = mock.data.state as TicketState;

    t.assert.equal(result, true);
    t.assert.equal(state.status, "RESERVED");
    t.assert.equal(state.reservedBy, "alice");
    t.assert.equal(mock.runs.includes("now"), true); // 時鐘取自 ctx.run（可重播）
    t.assert.equal(state.reservedUntil! >= before + 15 * 60 * 1000, true);
    t.assert.equal(state.reservedUntil! <= Date.now() + 15 * 60 * 1000, true);
    t.assert.equal(mock.sets.length, 1);
    t.assert.equal(mock.sets[0].key, "state");
  });

  // Issue #21：刻意變更語意——「同 user 重複 reserve 的冪等」改為
  // 「已 RESERVED 一律拒絕（含同一使用者）」拋 TerminalError，
  // 以杜絕同 user 併發結帳同座位造成的雙重扣款。
  // 重播安全：同 invocation 重試由 journal 重放，不會重呼 handler。
  // → 修復前紅燈（現行 return true）、修復後綠燈，故以 it.skip 交付。
  it.skip("同一使用者重複 reserve（已 RESERVED）：一律拒絕並拋 TerminalError（不再冪等回 true）", async (t) => {
    const future = Date.now() + 15 * 60 * 1000;
    const reserved: TicketState = {
      status: "RESERVED",
      reservedBy: "alice",
      reservedUntil: future,
    };
    const { mock, ctx } = withState({ state: reserved });

    await t.assert.rejects(() => handlers().reserve(ctx, "alice"), (err: Error) => {
      return err instanceof TerminalError && err.message === "Ticket is currently reserved";
    });

    t.assert.equal(mock.sets.length, 0); // 未再寫入
    t.assert.equal((mock.data.state as TicketState).reservedUntil, future); // 未延長
  });

  it("他人已 RESERVED（未過期）：丟 TerminalError('Ticket is currently reserved')", async (t) => {
    const future = Date.now() + 15 * 60 * 1000;
    const { ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: future },
    });
    await t.assert.rejects(() => handlers().reserve(ctx, "bob"), (err: Error) => {
      return err instanceof TerminalError && err.message === "Ticket is currently reserved";
    });
  });

  it("他人 RESERVED 但已逾期（TTL 過期）：允許新使用者預約並覆寫持有者", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: 1000 }, // 已過期
    });
    const result = await handlers().reserve(ctx, "bob");
    t.assert.equal(result, true);
    const state = mock.data.state as TicketState;
    t.assert.equal(state.status, "RESERVED");
    t.assert.equal(state.reservedBy, "bob");
  });

  it("已 SOLD：丟 TerminalError('Ticket already sold')", async (t) => {
    const { ctx } = withState({
      state: { status: "SOLD", reservedBy: "alice", reservedUntil: null },
    });
    await t.assert.rejects(() => handlers().reserve(ctx, "carol"), (err: Error) => {
      return err instanceof TerminalError && err.message === "Ticket already sold";
    });
  });
});

describe("Ticket.confirm()", () => {
  it("RESERVED → SOLD，清空 reservedUntil，維持 reservedBy", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: 999 },
    });
    const result = await handlers().confirm(ctx, "alice");
    const state = mock.data.state as TicketState;
    t.assert.equal(result, true);
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "alice");
    t.assert.equal(state.reservedUntil, null);
  });

  it("冪等：已 SOLD 且為同一人再 confirm 直接回 true，不再寫入", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "SOLD", reservedBy: "alice", reservedUntil: null },
    });
    t.assert.equal(await handlers().confirm(ctx, "alice"), true);
    t.assert.equal(mock.sets.length, 0);
  });

  it("防護：他人已買（SOLD）再 confirm → 拋出 TerminalError", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "SOLD", reservedBy: "alice", reservedUntil: null },
    });
    await t.assert.rejects(() => handlers().confirm(ctx, "bob"), (err: Error) => {
      return (
        err instanceof TerminalError &&
        err.message.includes("Ticket already sold to another user: alice")
      );
    });
    t.assert.equal(mock.sets.length, 0);
  });

  it("拒絕 AVAILABLE：未經預訂不得直接 confirm → 拋出 TerminalError", async (t) => {
    const { mock, ctx } = withState();
    await t.assert.rejects(() => handlers().confirm(ctx, "alice"), (err: Error) => {
      return (
        err instanceof TerminalError &&
        err.message.includes("Ticket is not reserved by user alice")
      );
    });
    t.assert.equal(mock.sets.length, 0);
  });

  it("防護：非保留者本人 confirm → 拋出 TerminalError", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: 123 },
    });
    await t.assert.rejects(() => handlers().confirm(ctx, "bob"), (err: Error) => {
      return (
        err instanceof TerminalError &&
        err.message.includes("Ticket is not reserved by user bob")
      );
    });
    t.assert.equal(mock.sets.length, 0);
  });

  it("防護：非法狀態值（如髒資料）→ TerminalError", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "HELD" as TicketState["status"], reservedBy: "alice", reservedUntil: null },
    });
    await t.assert.rejects(() => handlers().confirm(ctx, "alice"), (err: Error) => {
      return (
        err instanceof TerminalError &&
        err.message.includes("Ticket is not reserved by user alice")
      );
    });
    t.assert.equal(mock.sets.length, 0); // 拋錯前不寫入
  });
});

describe("Ticket.release() / cleanup() / get()", () => {
  it("release：保留者本人釋放 → 回到全空 AVAILABLE", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: 42 },
    });
    t.assert.equal(await handlers().release(ctx, "alice"), true);
    t.assert.deepStrictEqual(mock.data.state, DEFAULT_STATE);
  });

  it("release：非保留者嘗試釋放 → 忽略（回傳 false 不寫入）", async (t) => {
    const state = { status: "RESERVED", reservedBy: "alice", reservedUntil: 42 };
    const { mock, ctx } = withState({ state });
    t.assert.equal(await handlers().release(ctx, "bob"), false);
    t.assert.equal(mock.sets.length, 0);
  });

  it("release：無參數時系統重置回到全空 AVAILABLE", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "SOLD", reservedBy: "alice", reservedUntil: 42 },
    });
    t.assert.equal(await handlers().release(ctx), true);
    t.assert.deepStrictEqual(mock.data.state, DEFAULT_STATE);
  });

  it("cleanup：清除 state 鍵", async (t) => {
    const { mock, ctx } = withState({ state: { status: "SOLD" } });
    t.assert.equal(await handlers().cleanup(ctx), true);
    t.assert.deepStrictEqual(mock.clears, ["state"]);
    t.assert.equal("state" in mock.data, false);
  });

  it("get：無狀態時回預設 AVAILABLE（不寫回）", async (t) => {
    const { mock, ctx } = withState();
    t.assert.deepStrictEqual(await handlers().get(ctx), DEFAULT_STATE);
    t.assert.equal(mock.sets.length, 0);
  });

  it("get：有狀態時原樣回傳", async (t) => {
    const stored: TicketState = { status: "RESERVED", reservedBy: "bob", reservedUntil: 7 };
    const { ctx } = withState({ state: stored });
    t.assert.deepStrictEqual(await handlers().get(ctx), stored);
  });
});
