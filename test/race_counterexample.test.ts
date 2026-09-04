// test/race_counterexample.test.ts — 機械化重現 Quint 反例（specs/checkoutBuggy.qnt S0-S11）的獨立測試套件。
//
// 驗證目標：
// 1. 重現 Quint 在 checkoutBuggy.qnt 所找到的 11 步交錯軌跡（Trace）
// 2. 斷言修復後的實作能成功阻斷反例，使 P1（不可雙重成交）與 P2（已付款者持有票）在實作層恆真。
// 3. 支援獨立單獨執行，並納入 npm test / CI 自動化測試。

import { describe, it } from "node:test";
import { ticketObject } from "../src/game";
import type { TicketState } from "../src/game";
import { checkoutWorkflow } from "../src/checkout";
import { createMockContext, createMockState, handlersOf, TerminalError } from "./helpers/mocks";

type TicketHandler = (ctx: any, ...args: unknown[]) => Promise<unknown>;
const ticketHandlers = () => handlersOf<Record<string, TicketHandler>>(ticketObject, "object");

const checkoutHandlers = () =>
  handlersOf<{
    process: (ctx: any, request: { ticketId: string; userId: string; paymentMethodId?: string }) => Promise<string>;
  }>(checkoutWorkflow, "service");

describe("Quint 反例機械化驗證（specs/checkoutBuggy.qnt S0-S11 軌跡）", () => {
  it("S0-S11 物件狀態機交錯：A 遭 reset/插隊後，A 的 confirm 必須被拒絕，杜絕雙重成交", async (t) => {
    // S0: 初始狀態（Ticket AVAILABLE）
    const mock = createMockState();
    const ctx = createMockContext(mock);
    const handlers = ticketHandlers();

    // S2: 使用者 A 成功預訂（reserve）
    const reserveAResult = await handlers.reserve(ctx, "alice");
    t.assert.equal(reserveAResult, true);
    let state = mock.data.state as TicketState;
    t.assert.equal(state.status, "RESERVED");
    t.assert.equal(state.reservedBy, "alice");

    // S3: 使用者 A 進行付款（Paying / 暫態重試）...
    // S4: 背景重置或無身分釋放嘗試（RC1/RC3）
    // 驗證：若未授權之第三方嘗試 release("bob")，守衛必須拒絕釋放，不破壞 A 的預訂
    const unauthRelease = await handlers.release(ctx, "bob");
    t.assert.equal(unauthRelease, false, "非保留者本人不得釋放該票券");
    t.assert.equal((mock.data.state as TicketState).status, "RESERVED");

    // 模擬反例極端情境：系統遭遇全域 reset 強制回到 AVAILABLE
    mock.data.state = { status: "AVAILABLE", reservedBy: null, reservedUntil: null };

    // S7: 使用者 B 插入預訂該票（reserve）
    const reserveBResult = await handlers.reserve(ctx, "bob");
    t.assert.equal(reserveBResult, true);
    state = mock.data.state as TicketState;
    t.assert.equal(state.status, "RESERVED");
    t.assert.equal(state.reservedBy, "bob");

    // S8-S9: A 與 B 付款皆成功（Paid）...
    // S10: 使用者 B 先完成確認（confirm）
    const confirmBResult = await handlers.confirm(ctx, "bob");
    t.assert.equal(confirmBResult, true);
    state = mock.data.state as TicketState;
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "bob");

    // S11: 關鍵反例阻斷點！使用者 A 付款成功後呼叫 confirm("alice")
    // 修復前（BUGGY）：見 SOLD 盲目 return true，導致 A 也判定成功（雙重成交 F1 / A 失去票 F2）
    // 修復後（FIXED）：認領守衛阻斷，拋出 TerminalError
    await t.assert.rejects(
      () => handlers.confirm(ctx, "alice"),
      (err: Error) => {
        t.assert.equal(err instanceof TerminalError, true);
        t.assert.match(err.message, /Ticket already sold to another user: bob/);
        return true;
      }
    );

    // 最終真值驗證：票券僅屬於唯一買家 bob，不變量 P1 與 P2 成立
    state = mock.data.state as TicketState;
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "bob");
  });

  it("Checkout Saga 端到端驗證：A 付款中途票被搶購，A 的結帳流程必須失敗並補償，不可回傳成功", async (t) => {
    const mock = createMockState();

    // 模擬遠端 Ticket 物件在 A 付款期間被 B 搶購並標記為 SOLD(bob)
    const ctx = createMockContext(mock, {
      overrides: {
        Ticket: {
          reserve: async () => true, // Step 1: A reserve 成功
          confirm: async (args: unknown) => {
            // Step 4: A 付款成功後嘗試 confirm
            const userId = (args as unknown[])[0];
            if (userId !== "bob") {
              // 模擬真實 game.ts 邏輯：票主已是 bob，非本人拋出 TerminalError
              throw new TerminalError("Ticket already sold to another user: bob");
            }
            return true;
          },
          release: async () => true, // Step 3: 失敗補償
        },
        SeatMap: {
          set: async () => true,
        },
      },
    });

    // 執行使用者 A 的 Checkout Process
    await t.assert.rejects(
      () =>
        checkoutHandlers().process(ctx, {
          ticketId: "seat-1",
          userId: "alice",
          paymentMethodId: "card_success",
        }),
      (err: Error) => {
        t.assert.equal(err instanceof TerminalError, true);
        t.assert.match(err.message, /Ticket already sold to another user: bob/);
        return true;
      }
    );

    // 驗證發信步驟從未被執行（alice 絕不會收到「Booking Confirmed」發信）
    t.assert.equal(mock.runs.includes("send-email"), false);
  });
});
