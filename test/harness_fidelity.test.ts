// test/harness_fidelity.test.ts — Issue #20 ⑤：整合式 harness 的自我驗證測試。
//
// 本檔案不測 src/ 的行為，測的是 test/helpers/integration.ts 這套 harness 的
// 「保真度能力」本身：
//   ① per-(service,key) 非同步互斥（逼近 Restate Virtual Object exclusive）
//   ② fire-and-forget 的 pending queue ＋ deliver(n)/drain()（延遲投遞視窗）
//   ③ ctx.run 的 before/after hook（精準插隊控制點）
//   ④ world.calls 呼叫軌跡（沿用 mocks.ts 的 RecordedCall）
//
// 為什麼需要這層自我驗證：harness 是 S1–S6 情境測試與後續缺陷修復的「量測儀器」，
// 儀器本身回歸（例如互斥失效導致不可能交錯、或 send 又變回同步執行）時，
// 情境測試會「綠得不可信」。四組測試各釘住一項能力，儀器壞了就先在這裡紅。
import { describe, it } from "node:test";
import { createIntegration, TerminalError } from "./helpers/integration";
import type { TicketState } from "../src/game";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("harness 自我驗證①——per-(service,key) 互斥", () => {
  it("同 key 併發 reserve：序列化執行，第二個必然看到第一個的 RESERVED 而被拒", async (t) => {
    const itg = createIntegration();

    // 同時（不相依序 await）發起兩個使用者對同一座位的保留：
    // 沒有 per-key 互斥時，兩者在 `await ctx.get` 處交錯、都看到 AVAILABLE →
    // 雙重保留成功——這是 Restate exclusive 語意下生產環境不可能發生的交錯。
    const [alice, bob] = await Promise.allSettled([
      itg.ticket("mtx-1").reserve("alice"),
      itg.ticket("mtx-1").reserve("bob"),
    ]);

    t.assert.equal(alice.status, "fulfilled");
    t.assert.ok(alice.status === "fulfilled" && alice.value === true);
    // 互斥生效時 bob 必須被序列化到 alice 之後、看到 RESERVED(alice) 而丟擲
    t.assert.equal(bob.status, "rejected");
    t.assert.ok(bob.status === "rejected" && bob.reason instanceof TerminalError);

    const state = itg.stateOf("Ticket", "mtx-1").data.state as TicketState;
    t.assert.equal(state.status, "RESERVED");
    t.assert.equal(state.reservedBy, "alice"); // FIFO：先進隊者（alice）先取得鎖
  });

  it("鎖依 key 分離：某 key 的慢 handler 不阻塞其他 key；同 key 排隊；鎖鏈不被異常卡死", async (t) => {
    const itg = createIntegration();

    // 用 hook 讓 Ticket:slow 在 run("now") 前持有鎖 50ms（模擬慢 handler）
    itg.world.hooks.before = async (label, service, key) => {
      if (label === "now" && service === "Ticket" && key === "slow") {
        await sleep(50);
      }
    };

    const slow = itg.ticket("slow").reserve("alice"); // 進入 hook → 持鎖 50ms
    await sleep(10); // 確保 slow 已取得鎖並停在 hook 內
    const queued = itg.ticket("slow").reserve("bob"); // 同 key：排在 slow 之後
    const done: string[] = [];
    slow.then(() => done.push("slow"), () => done.push("slow"));
    queued.then(() => done.push("queued"), () => done.push("queued"));

    // 不同 key：必須不被 Ticket:slow 的鎖阻塞（若在 slow 之後完成 = 全域鎖，保真度不足）
    await itg.ticket("other-key").reserve("carol");
    t.assert.ok(!done.includes("slow"), "other-key 的 reserve 應先於被 hook 拖慢的 slow 完成");

    await Promise.allSettled([slow, queued]);
    t.assert.deepStrictEqual(done, ["slow", "queued"]);
    // bob 排在 alice 之後執行，看到的已是 RESERVED(alice) → 被拒（序列化語意）
    const state = itg.stateOf("Ticket", "slow").data.state as TicketState;
    t.assert.equal(state.reservedBy, "alice");

    // 鎖鏈錯誤韧性：handler 拋錯後，同 key 的後續呼叫仍要能取得鎖
    itg.world.hooks.before = async (label) => {
      if (label === "now") {
        throw new Error("hook-boom");
      }
    };
    const boom = await Promise.allSettled([itg.ticket("mtx-x").reserve("dave")]);
    t.assert.equal(boom[0].status, "rejected");
    itg.world.hooks.before = undefined;
    t.assert.equal(await itg.ticket("mtx-x").reserve("erin"), true); // 未被卡死
  });
});

describe("harness 自我驗證②——pending queue 與延遲投遞", () => {
  it("send client 僅入佇列不執行；deliver(n) 依 FIFO 投遞 n 筆；drain() 清空", async (t) => {
    const itg = createIntegration();

    await itg.manager.reset(); // GameManager.reset 經 objectSendClient ×51（SeatMap.reset + 50 release）

    // 延遲投遞視窗存在：51 筆都在佇列中，尚未有任何狀態改變
    t.assert.equal(itg.world.pendingSends.length, 51);
    t.assert.equal(itg.stateOf("SeatMap", "global").data.map, undefined);
    t.assert.equal(itg.stateOf("Ticket", "seat-1").data.state, undefined);
    t.assert.equal(itg.world.pendingSends[0].service, "SeatMap"); // FIFO：先進隊先投遞
    t.assert.equal(itg.world.pendingSends[0].handler, "reset");

    await itg.deliver(1); // 只投遞 1 筆
    const map = itg.stateOf("SeatMap", "global").data.map as Record<string, string>;
    t.assert.equal(map["seat-1"], "AVAILABLE"); // SeatMap.reset 生效
    t.assert.equal(itg.world.pendingSends.length, 50);
    t.assert.equal(itg.stateOf("Ticket", "seat-1").data.state, undefined); // 票仍未釋放

    await itg.drain(); // 投遞至清空（含投遞期間新進隊者）
    t.assert.equal(itg.world.pendingSends.length, 0);
    const state = itg.stateOf("Ticket", "seat-1").data.state as TicketState;
    t.assert.equal(state.status, "AVAILABLE");
    t.assert.deepStrictEqual(itg.world.deliveryErrors, []);
  });

  it("send 呼叫立即返回（fire-and-forget 不阻塞 sender）；投遞異常記錄進 deliveryErrors 不外溢", async (t) => {
    const itg = createIntegration();

    // 透過真實跨物件路徑進隊：SeatMap 湊滿 50 SOLD → serviceSendClient(GameManager).reset()
    for (let i = 1; i <= 50; i++) {
      await itg.seatMap.set({ seatId: `seat-${i}`, status: "SOLD" });
    }
    // sender（SeatMap.set handler）未被投遞阻塞即返回：set 完成時佇列有 1 筆待投
    t.assert.equal(itg.world.pendingSends.length, 1);
    t.assert.equal(itg.world.pendingSends[0].service, "GameManager");

    // 手動塞入一筆必失敗的待投項目，驗證投遞迴路把異常隔離記錄（不會 unhandled rejection 打爆測試行程）
    itg.world.pendingSends.push({
      kind: "service",
      service: "Ticket",
      key: "",
      handler: "reserve",
      args: [],
      fn: () => {
        throw new Error("delivery-boom");
      },
    });
    await itg.drain(); // 不應拋出
    t.assert.equal(itg.world.pendingSends.length, 0);
    t.assert.equal(itg.world.deliveryErrors.length, 1);
    t.assert.match(String((itg.world.deliveryErrors[0] as Error).message), /delivery-boom/);
    // 真實的 GameManager.reset 仍已被正常投遞（50 張票釋放）
    const state = itg.stateOf("Ticket", "seat-1").data.state as TicketState;
    t.assert.equal(state.status, "AVAILABLE");
  });
});

describe("harness 自我驗證③——ctx.run 插隊控制點 hook", () => {
  it("before/after 依序包住每個 run（含 run(\"now\")），且 after 會被 await（同步插隊语义）", async (t) => {
    const itg = createIntegration();
    const seen: string[] = [];
    itg.world.hooks.before = (label, service, key) => {
      seen.push(`before:${service}:${key}:${label}`);
    };
    itg.world.hooks.after = async (label, service, key) => {
      seen.push(`after:${service}:${key}:${label}`);
      await sleep(5); // 若 run 不等 after，下面這條 mark 會排到後續 label 之後
      seen.push(`after-settled:${label}`);
    };

    await itg.checkout.process({ ticketId: "hk", userId: "alice", paymentMethodId: "card_success" });

    // 精確期望序：reserve 內的 run("now") → 付款 run → 寄信 run；
    // SeatMap.set/confirm 沒有 run。順序與 await 語意一起被釘住。
    t.assert.deepStrictEqual(seen, [
      "before:Ticket:hk:now",
      "after:Ticket:hk:now",
      "after-settled:now",
      "before:Checkout::process-payment",
      "after:Checkout::process-payment",
      "after-settled:process-payment",
      "before:Checkout::send-email",
      "after:Checkout::send-email",
      "after-settled:send-email",
    ]);
  });
});

describe("harness 自我驗證④——world.calls 呼叫軌跡", () => {
  it("每次真實 handler 執行（服務入口/跨物件 client/延遲投遞）都按序進軌跡並記錄 args", async (t) => {
    const itg = createIntegration();

    await itg.checkout.process({ ticketId: "tr", userId: "alice", paymentMethodId: "card_success" });
    t.assert.deepStrictEqual(
      itg.world.calls.map((c) => `${c.service}:${c.key}.${c.handler}`),
      [
        "Checkout:.process",
        "Ticket:tr.reserve",
        "SeatMap:global.set",
        "Ticket:tr.confirm",
        "SeatMap:global.set",
      ]
    );
    const reserve = itg.world.calls.find((c) => c.handler === "reserve");
    t.assert.ok(reserve);
    t.assert.deepStrictEqual(reserve?.args, ["alice"]); // RecordedCall 形狀：args 逐欄記錄
    const firstSet = itg.world.calls.filter((c) => c.service === "SeatMap")[0];
    t.assert.deepStrictEqual(firstSet?.args, [{ seatId: "tr", status: "RESERVED" }]);

    // 延遲投遞的項目「進佇列」不進軌跡，投遞執行時才進軌跡
    await itg.manager.reset();
    t.assert.equal(
      itg.world.calls.filter((c) => c.service === "Ticket" && c.key === "seat-1").length,
      0
    );
    await itg.drain();
    const release = itg.world.calls.find(
      (c) => c.service === "Ticket" && c.key === "seat-1" && c.handler === "release"
    );
    t.assert.ok(release, "投遞後的 Ticket.release 應出現在呼叫軌跡");
  });
});
