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
//   S3  confirm（try 外）拋錯後的 view 收斂（characterization：釘住現行缺陷行為）
//   S4  TTL 逾期釋放整鏈路（A 保留→過期→B 買→A confirm 失敗）
//   S6  湊滿 50 SOLD → auto-reset → GameManager 釋放全部票
//
// 每個情境若揭露「既有缺陷」（紅燈且非測試自身錯誤），以 it.skip 交付
// （斷言完整保留、單獨 CI 綠），並在 Issue 留言報告、建議另開 agent-fix-bug。
//
// Issue #20：harness 升級為 per-key 互斥＋延遲投遞＋run hook 插隊＋呼叫軌跡；
// S3 由 it.skip 轉為可在插隊控制點下精确重現的 characterization test，
// S6 的恆真斷言（未建 Ticket slot → undefined 恒綠）修正為真實鏈路斷言。
import { describe, it } from "node:test";
import { createIntegration, TerminalError } from "./helpers/integration";
import type { TicketState } from "../src/game";

describe("整合式情境 S1——同 user 併發下單同座位（雙重扣款防護）", () => {
  // Issue #21：S1 由循序改為併發，以重現「同 user 併發結帳同座位」的雙重扣款缺陷。
  // 修復（src/game.ts reserve 對已 RESERVED 一律拒絕）前，兩次 checkout.process 會各自
  // reserve 成功（同 user 冪等 return true）→ 各付一次款、各發一次信 → 兩次 Booking Confirmed。
  // 修復後僅一次成功，另一方 reserve 拋 TerminalError，走補償路徑（不做付款/發信）。
  // → 修復前紅燈（2 次付款）、修復後綠燈（1 次付款），故以 it.skip 交付（斷言完整保留）。
  it("同一 user 併發兩次結帳同座位：僅一次 Booking Confirmed，付款/發信各只執行 1 次", async (t) => {
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
  // 缺陷（Issue #17 §B.4 → Issue #22）：checkout.ts 補償路徑無條件 seatMap.set(AVAILABLE)，
  // 未理會 ticket.release(userId) 對「已 SOLD」回傳 false——真值 SOLD 時 view 仍被抹成
  // AVAILABLE，且該寫入發生在買家寫入 SOLD 之後（last-writer-wins）→ 永久性幽靈可售票。
  //
  // Issue #22 前的舊版測試走錯路徑：讓 alice 對「已 SOLD」座位下單，會在 step1 的
  // reserve（try/catch 之外）就拋錯 → 補償區塊根本不執行，故驗不到本缺陷。
  // 現改用 Issue #20 ③ 的 ctx.run hook 在「alice 已 reserve、補償尚未開始」的視窗精準插隊，
  // 讓 alice 確實走進補償路徑（release 回 false、但仍回寫 view）。
  //
  // 註：此處用 before hook 而非 after——付款失敗時 `await fn()` 直接外拋，
  // harness 的 after hook 不會被觸發（見 helpers/integration.ts 的 ctx.run）。
  // before("process-payment") 位於 step1 reserve 之後、補償之前，正是所需視窗。
  it("補償不得把 view 回寫 AVAILABLE（真值已 SOLD 給他人時）", async (t) => {
    const itg = createIntegration();

    // 控制點：alice 的付款開始前（step1 reserve 已完成）插隊，
    // 模擬「回合重置 → bob 買走同一張票並寫入較新的 view=SOLD」。
    let injected = false;
    itg.world.hooks.before = async (label) => {
      if (label !== "process-payment" || injected) {
        return;
      }
      injected = true;
      // 背景重置：GameManager.reset 以 fire-and-forget 釋放所有票（含 alice 的保留）
      await itg.manager.reset();
      await itg.drain(); // 投遞 reset 產生的 SeatMap.reset ＋ 50 張 Ticket.release
      // bob 買走同一張票，並寫入較新的 view=SOLD
      await itg.ticket("seat-2").reserve("bob");
      await itg.ticket("seat-2").confirm("bob");
      await itg.seatMap.set({ seatId: "seat-2", status: "SOLD" });
    };

    // alice 以 card_decline 下單：step1 reserve 成功 → 付款失敗 → 進入補償
    await t.assert.rejects(
      async () =>
        await itg.checkout.process({
          ticketId: "seat-2",
          userId: "alice",
          paymentMethodId: "card_decline",
        }),
      (err: Error) => err instanceof TerminalError && /Payment failed/.test(err.message)
    );
    t.assert.equal(injected, true, "插隊必須發生在付款後、補償前");

    // 補償確實嘗試過釋放（但因票已 SOLD 給他人，release 回 false、不改真值）
    const releaseCalls = itg.world.calls.filter(
      (c) => c.service === "Ticket" && c.key === "seat-2" && c.handler === "release"
    );
    t.assert.equal(releaseCalls.length >= 1, true, "補償應嘗試過 release");

    // 真值：票已成交給 bob，未被 alice 的補償釋放
    const state = itg.stateOf("Ticket", "seat-2").data.state as TicketState;
    t.assert.equal(state.status, "SOLD");
    t.assert.equal(state.reservedBy, "bob");

    // 關鍵斷言：alice 的補償不得覆蓋 bob 較新的 SOLD → view 必須與真值一致
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string> | undefined;
    t.assert.notEqual(map?.["seat-2"], "AVAILABLE", "真值 SOLD 時 view 不得為 AVAILABLE（幽靈可售票）");
    t.assert.equal(map?.["seat-2"], "SOLD", "view 應與真值一致");
  });
});

describe("整合式情境 S3——confirm（try 外）拋錯後的 view 收斂", () => {
  // Issue #20 ⑥：原 it.skip 的「名實不符」修正。舊測試並未真正走到「confirm 拋錯」
  // （bob 在 step1 reserve 就被拒），且自承單執行緒 harness 無法精確插隊。
  // 現在 harness 提供 ctx.run after hook（Issue #20 ③），可在「process-payment 完成、
  // confirm 之前」注入第三人操作，真正重現 defect 文（Issue #17 §B.4）描述的路徑。
  //
  // 本測試為 characterization test：誠實釘住「現行行為」——
  //   a) confirm 的 TerminalError 未被 try/catch 包住 → 原樣外拋（非 "Payment failed" 包裝）；
  //   b) 真值已被插隊者清空（get() 落回 AVAILABLE 預設），但 SeatMap view 殘留 step1 的
  //      RESERVED、無補償回寫——即「view 與真值不一致」的既有缺陷。
  // 待 agent-fix-bug 修復收斂路徑時，本測試的 view 殘留斷言應翻為正確語意
  // （補償回寫 AVAILABLE），這正是 characterization test 的價值：修復造成可觀察的差異。
  it("插隊後 confirm 拋錯：原樣外拋 TerminalError，view 現行殘留 RESERVED（characterization）", async (t) => {
    const itg = createIntegration();

    // 控制點：付款 run 結束後、程式繼續走向 confirm 之前，第三人清掉這張票
    let injected = false;
    itg.world.hooks.after = async (label) => {
      if (label === "process-payment") {
        await itg.ticket("seat-3").cleanup();
        injected = true;
      }
    };

    let captured: unknown;
    await t.assert.rejects(
      async () => await itg.checkout.process({ ticketId: "seat-3", userId: "alice", paymentMethodId: "card_success" }),
      (err: Error) => {
        captured = err;
        return err instanceof TerminalError;
      }
    );
    t.assert.equal(injected, true); // 插隊確實發生在 confirm 之前
    // 外拋的是 confirm 的原始錯誤（checkout.ts:38 在 try 外，無 "Payment failed" 包裝）
    t.assert.match(String((captured as Error).message), /not reserved by user alice/);

    // 真值：state 已被 cleanup 清空（slot 存在、data.state 不存在）
    t.assert.equal(itg.stateOf("Ticket", "seat-3").data.state, undefined);
    // 現行行為（缺陷釘選）：view 殘留 step1 寫的 RESERVED，與真值（AVAILABLE）矛盾
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.equal(map["seat-3"], "RESERVED");
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
  // Issue #20 ⑥：修正恆真斷言。舊版只寫 SeatMap view、從未建立任何 Ticket slot，
  // `ticketState === undefined || ...` 因此恒綠——釋放鏈路壞了也不會紅。
  // 現在先讓每席走真實 reserve+confirm（真值 SOLD），再湊滿 50 個 view SOLD：
  // auto-reset 的 GameManager.reset 在新 harness 下是「待投遞」而非同步完成——
  // 投遞前真值仍 SOLD（證明斷言非恆真）、drain 後才全部釋放。
  it("50 席真值 SOLD 觸發 auto-reset：view 全 AVAILABLE、reset 入 pending queue、drain 後票全數釋放", async (t) => {
    const itg = createIntegration();

    // 真整合式：每席先經 Ticket 真實 handler 賣出，再寫 view（最後一席湊滿 50）
    for (let i = 1; i <= 50; i++) {
      const ticket = itg.ticket(`seat-${i}`);
      await ticket.reserve(`user-${i}`);
      await ticket.confirm(`user-${i}`);
      await itg.seatMap.set({ seatId: `seat-${i}`, status: "SOLD" });
    }

    // 湊滿 50 時觸發 auto-reset：本地 map 立即全部回 AVAILABLE（同步部分）
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.equal(Object.keys(map).length, 50);
    t.assert.equal(Object.values(map).every((s) => s === "AVAILABLE"), true);

    // fire-and-forget 語意：GameManager.reset 只在 pending queue 裡，尚未執行
    t.assert.equal(itg.world.pendingSends.length, 1);
    t.assert.equal(itg.world.pendingSends[0].service, "GameManager");
    t.assert.equal(itg.world.pendingSends[0].handler, "reset");

    // 投遞前：真值仍是 SOLD（slot 必然存在——這是舊版恆真斷言永遠看不見的）
    const before = itg.stateOf("Ticket", "seat-1").data.state as TicketState;
    t.assert.equal(before.status, "SOLD");
    t.assert.equal(before.reservedBy, "user-1");

    // 投遞全部待辦（GameManager.reset → 又進隊 SeatMap.reset + 50 張票的 release）
    await itg.drain();
    t.assert.equal(itg.world.pendingSends.length, 0);
    for (let i = 1; i <= 50; i++) {
      const st = itg.stateOf("Ticket", `seat-${i}`).data.state as TicketState;
      t.assert.equal(st.status, "AVAILABLE");
      t.assert.equal(st.reservedBy, null);
    }
    // SeatMap.reset 亦已投遞：view 維持 50 席全 AVAILABLE
    const map2 = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.equal(Object.keys(map2).length, 50);
    t.assert.equal(Object.values(map2).every((s) => s === "AVAILABLE"), true);
  });
});
