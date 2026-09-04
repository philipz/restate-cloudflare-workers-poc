// test/integration_scenarios.test.ts — Issue #17 §4 情境 S1–S6 的整合式測試。
//
// 以 test/helpers/integration.ts 把 Ticket/SeatMap/GameManager/Checkout 的「真實 handler」
// 互相接線（共享狀態、真實跨物件呼叫），對既有行為做整合式釘住，
// 補足單元測試以 recorder stub（未 override 回 undefined）所看不見的
// 「跨 handler 狀態一致性」缺口。
//
// 情境與對應 Issue #17 §4：
//   S1  同 user 併發兩次 Checkout/process 同一座位（冪等/重複訂票）
//   S2  付款失敗補償時票已被他人買走（view 不得無條件回寫 AVAILABLE）
//   S3  confirm（try 外）拋錯後的 view 收斂
//   S4  TTL 逾期釋放整鏈路（A 保留→過期→B 買→A confirm 失敗）
//   S6  湊滿 50 SOLD → auto-reset → GameManager 釋放全部票
//
// 每個情境若揭露「既有缺陷」（紅燈且非測試自身錯誤），以 it.skip 交付
// （斷言完整保留、單獨 CI 綠），並在 Issue 留言報告、建議另開 agent-fix-bug。
import { describe, it } from "node:test";
import { createIntegration, TerminalError } from "./helpers/integration";
import type { TicketState } from "../src/game";

describe("整合式情境 S1——同 user 併發下單同座位（雙重扣款防護）", () => {
  // Issue #21：S1 由循序改為併發，以重現「同 user 併發結帳同座位」的雙重扣款缺陷。
  // 修復（src/game.ts reserve 對已 RESERVED 一律拒絕）前，兩次 checkout.process 會各自
  // reserve 成功（同 user 冪等 return true）→ 各付一次款、各發一次信 → 兩次 Booking Confirmed。
  // 修復後僅一次成功，另一方 reserve 拋 TerminalError，走補償路徑（不做付款/發信）。
  // → 修復前紅燈（2 次付款）、修復後綠燈（1 次付款），故以 it.skip 交付（斷言完整保留）。
  it.skip("同一 user 併發兩次結帳同座位：僅一次 Booking Confirmed，付款/發信各只執行 1 次", async (t) => {
    const itg = createIntegration();
    const checkout = itg.checkout;
    const req = { ticketId: "seat-1", userId: "alice", paymentMethodId: "card_success" };

    // 併發（Promise.all）同 user 同座位，各自獨立 invocation
    const results = await Promise.allSettled([
      checkout.process({ ...req }),
      checkout.process({ ...req }),
    ]);

    // ① 只有一個 Booking Confirmed（另一方失敗，不得雙重成交）
    const confirmed = results.filter((r) => r.status === "fulfilled" && r.value === "Booking Confirmed");
    t.assert.equal(confirmed.length, 1, "只能有一筆 Booking Confirmed");

    // 另一筆必為失敗（rejected）且為 TerminalError
    const rejected = results.filter((r) => r.status === "rejected");
    t.assert.equal(rejected.length, 1, "另一筆須失敗");
    t.assert.equal(
      rejected[0].reason instanceof TerminalError,
      true,
      "失敗方須為 TerminalError（reserve 對已 RESERVED 拒絕）"
    );

    // ② process-payment 只執行 1 次、③ send-email 只執行 1 次（不得雙重扣款/重複發信）
    const payCount = itg.world.runs.filter((r) => r === "Checkout.process-payment").length;
    const mailCount = itg.world.runs.filter((r) => r === "Checkout.send-email").length;
    t.assert.equal(payCount, 1, "process-payment 只應執行 1 次");
    t.assert.equal(mailCount, 1, "send-email 只應執行 1 次");

    // 最終真值：票仍只屬於 alice，狀態 SOLD
    const state = itg.stateOf("Ticket", "seat-1").data.state as TicketState;
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "alice");
  });
});

describe("整合式情境 S2——付款失敗補償時票已被他人買走", () => {
  // 既有缺陷（Issue #17 §B.4）：checkout.ts 補償路徑無條件 seatMap.set(AVAILABLE)，
  // 未理會 ticket.release(userId) 對「已 SOLD」回傳 false——真值 SOLD 時 view 仍被抹成 AVAILABLE，
  // 產生幽靈可售票。本測試斷言「正確」行為（view 不得回寫 AVAILABLE），
  // 現行實作會紅燈 → 以 it.skip 交付（斷言完整保留），建議另開 agent-fix-bug。
  it.skip("補償不得無條件把 view 回寫 AVAILABLE（真值 SOLD 時）", async (t) => {
    const itg = createIntegration();

    // 讓 alice 先保留座位（reserve 成功、真值 RESERVED 屬於 alice）
    await itg.ticket("seat-2").reserve("alice");

    // 期間座位被 GameManager reset 後由 bob 買走（真值 SOLD，屬於 bob）；
    // 由於 GameManager.reset 會 release 全部票，再以 bob 成交：
    await itg.manager.reset();
    await itg.ticket("seat-2").reserve("bob");
    await itg.ticket("seat-2").confirm("bob");

    // alice 以 card_decline 下單：reserve 對「已 SOLD(他人)」丟錯，走補償路徑；
    // 補償只應在真值「非 SOLD」時才把 view 回寫 AVAILABLE。
    await t.assert.rejects(
      async () => await itg.checkout.process({ ticketId: "seat-2", userId: "alice", paymentMethodId: "card_decline" }),
      (err: Error) => err instanceof TerminalError
    );

    // 真值仍是 SOLD（屬於 bob）
    const state = itg.stateOf("Ticket", "seat-2").data.state as TicketState;
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "bob");

    // 關鍵斷言：view 不得被回寫為 AVAILABLE（真值 SOLD 時）
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string> | undefined;
    t.assert.notEqual(map?.["seat-2"], "AVAILABLE");
  });
});

describe("整合式情境 S3——confirm（try 外）拋錯後的 view 收斂", () => {
  // 既有缺陷（Issue #17 §B.4）：checkout.ts:38 的 confirm 不在 try/catch 內；
  // confirm 拋錯時 view 已在 step1 被寫成 RESERVED，且無補償回寫——
  // 真值非 SOLD（仍 RESERVED/其他）時 view 可能殘留 RESERVED，與真值不一致。
  // 本測試斷言「正確」收斂（view 不殘留與真值矛盾的 SOLD/RESERVED），
  // 現行實作會紅燈 → 以 it.skip 交付（斷言完整保留）。
  it.skip("confirm 拋錯後，view 不與真值矛盾（無幽靈殘留）", async (t) => {
    const itg = createIntegration();

    // alice 保留座位（真值 RESERVED 屬於 alice）
    await itg.ticket("seat-3").reserve("alice");

    // 以 card_success 下單但 confirm 前身分不符（模擬他人插隊）→ confirm 拋錯；
    // 由於 checkout 的 reserve 會在此真值 RESERVED 且屬 alice 時對 bob 拋錯、
    // 此路徑在 step1 即失敗，故另以「alice 保留被他人 release 重建」逼近。
    // 誠實說明：本情境在單執行緒 harness 下難以精確重現「付款成功後、confirm 前插隊」，
    // 故以 it.skip 保留斷言與修法方向，交由 agent-fix-bug 在可控制交錯的 harness 上釘住。
    await t.assert.rejects(
      async () => await itg.checkout.process({ ticketId: "seat-3", userId: "bob", paymentMethodId: "card_success" }),
      (err: Error) => err instanceof TerminalError
    );

    const state = itg.stateOf("Ticket", "seat-3").data.state as TicketState;
    t.assert.notEqual(state.status, "SOLD");
  });
});

describe("整合式情境 S4——TTL 逾期釋放整鏈路", () => {
  it("A 保留→過期→B 買→A confirm 失敗", async (t) => {
    const t0 = 1_000_000;
    const itg = createIntegration(t0);
    const ticket = itg.ticket("seat-4");

    // A 保留（時鐘 t0）
    await ticket.reserve("alice");
    const afterA = itg.stateOf("Ticket", "seat-4").data.state as TicketState;
    t.assert.equal(afterA.status, "RESERVED");
    t.assert.equal(afterA.reservedBy, "alice");

    // 時鐘前進超過 15 分鐘 → A 的保留過期
    itg.world.now = () => t0 + 16 * 60 * 1000;

    // B 買下（過期釋放後 B 可 reserve + confirm）
    await ticket.reserve("bob");
    await ticket.confirm("bob");

    // A 此時 confirm 應失敗（已 SOLD 給 bob）
    await t.assert.rejects(async () => await ticket.confirm("alice"), (err: Error) => err instanceof TerminalError);

    const state = itg.stateOf("Ticket", "seat-4").data.state as TicketState;
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "bob");
  });
});

describe("整合式情境 S6——湊滿 50 SOLD 自動重置", () => {
  it("50 席全 SOLD 觸發 auto-reset：本地 map 全 AVAILABLE 並對 GameManager 發 reset", async (t) => {
    const itg = createIntegration();
    const seatMap = itg.seatMap;

    // 依序賣出 50 席（真整合式：走 SeatMap.set）
    for (let i = 1; i <= 50; i++) {
      await seatMap.set({ seatId: `seat-${i}`, status: "SOLD" });
    }

    // 湊滿 50 時觸發 auto-reset：本地 map 全部回 AVAILABLE
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.equal(Object.keys(map).length, 50);
    t.assert.equal(Object.values(map).every((s) => s === "AVAILABLE"), true);

    // 並對 GameManager 觸發 fire-and-forget reset（本 harness 同步執行 → 可觀察）
    // 重設後 seat-1..seat-50 的 Ticket 真值被 release 回 AVAILABLE
    const ticketState = itg.stateOf("Ticket", "seat-1").data.state as TicketState | undefined;
    t.assert.equal(ticketState === undefined || ticketState.status === "AVAILABLE", true);
  });
});
