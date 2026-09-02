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

  it("同一使用者重複 reserve：回傳 true 但不更新保留期（既有的冪等行為）", async (t) => {
    const reserved: TicketState = {
      status: "RESERVED",
      reservedBy: "alice",
      reservedUntil: 1234,
    };
    const { mock, ctx } = withState({ state: reserved });
    const result = await handlers().reserve(ctx, "alice");

    t.assert.equal(result, true);
    t.assert.equal(mock.sets.length, 0); // 未再寫入
    t.assert.equal((mock.data.state as TicketState).reservedUntil, 1234); // 未延長
  });

  it("他人已 RESERVED：丟 TerminalError('Ticket is currently reserved')", async (t) => {
    const { ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: 1234 },
    });
    await t.assert.rejects(() => handlers().reserve(ctx, "bob"), (err: Error) => {
      return err instanceof TerminalError && err.message === "Ticket is currently reserved";
    });
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
  it("RESERVED → SOLD，清空 reservedUntil", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "RESERVED", reservedBy: "alice", reservedUntil: 999 },
    });
    const result = await handlers().confirm(ctx);
    const state = mock.data.state as TicketState;
    t.assert.equal(result, true);
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedUntil, null);
  });

  it("冪等：已 SOLD 再 confirm 直接回 true，不再寫入", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "SOLD", reservedBy: "alice", reservedUntil: null },
    });
    t.assert.equal(await handlers().confirm(ctx), true);
    t.assert.equal(mock.sets.length, 0);
  });

  it("容忍 AVAILABLE（與 reset 賽兵的放寬路徑）→ 直接 SOLD", async (t) => {
    const { mock, ctx } = withState();
    t.assert.equal(await handlers().confirm(ctx), true);
    t.assert.equal((mock.data.state as TicketState).status, "SOLD");
  });

  it("邊界（既有行為）：reservedBy 為 null 的 RESERVED 狀態可被任何人 confirm", async (t) => {
    // 現行實作 confirm 不檢查 ctx 身份／保留者——POC 假設僅 checkout 呼叫。
    const { mock, ctx } = withState({
      state: { status: "RESERVED", reservedBy: null, reservedUntil: 123 },
    });
    t.assert.equal(await handlers().confirm(ctx), true);
    t.assert.equal((mock.data.state as TicketState).status, "SOLD");
  });

  it("防護：非法狀態值（如髒資料）→ TerminalError('Ticket is in status …, cannot confirm')", async (t) => {
    const { mock, ctx } = withState({
      state: { status: "HELD" as TicketState["status"], reservedBy: null, reservedUntil: null },
    });
    await t.assert.rejects(() => handlers().confirm(ctx), (err: Error) => {
      return (
        err instanceof TerminalError &&
        err.message === "Ticket is in status HELD, cannot confirm"
      );
    });
    t.assert.equal(mock.sets.length, 0); // 拋錯前不寫入
  });
});

describe("Ticket.release() / cleanup() / get()", () => {
  it("release：任何狀態回到全空 AVAILABLE", async (t) => {
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
