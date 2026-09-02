// src/checkout.ts — Checkout saga（訂票→付款→失敗補償→確認→發信）單元測試。
// 以 mock Context 驅動：objectClient 記錄對 Ticket/SeatMap 的呼叫（可注入失敗），
// ctx.run 即時執行被持久化的閉包（真實走 processPayment/sendEmail 模擬邏輯）。
import { describe, it } from "node:test";
import { checkoutWorkflow } from "../src/checkout";
import { createMockContext, createMockState, handlersOf, TerminalError } from "./helpers/mocks";
import type { RecordedCall } from "./helpers/mocks";

const handlers = () =>
  handlersOf<{
    process: (ctx: any, request: { ticketId: string; userId: string; paymentMethodId?: string }) => Promise<string>;
  }>(checkoutWorkflow, "service");

function callOf(calls: RecordedCall[], handler: string, service?: string) {
  return calls.filter((c) => c.handler === handler && (service === undefined || c.service === service));
}

describe("Checkout.process() — 成功路径", () => {
  it("完整順序：reserve → RESERVED → 付款 → confirm → SOLD → 發信，回 'Booking Confirmed'", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);

    const result = await handlers().process(ctx, { ticketId: "seat-7", userId: "alice" });

    t.assert.equal(result, "Booking Confirmed");
    t.assert.deepStrictEqual(
      mock.objectCalls.map((c) => `${c.service}.${c.handler}`),
      ["Ticket.reserve", "SeatMap.set", "Ticket.confirm", "SeatMap.set"]
    );
    t.assert.deepStrictEqual(mock.objectCalls[0], {
      service: "Ticket",
      key: "seat-7",
      handler: "reserve",
      args: ["alice"],
    });
    t.assert.deepStrictEqual(mock.objectCalls[1].args, [{ seatId: "seat-7", status: "RESERVED" }]);
    t.assert.deepStrictEqual(mock.objectCalls[3].args, [{ seatId: "seat-7", status: "SOLD" }]);
    t.assert.deepStrictEqual(mock.runs, ["process-payment", "send-email"]);
    // 未指定 paymentMethodId 時套用預設 "card_success"（payment 閉包實際執行成功）
    t.assert.equal(callOf(mock.objectCalls, "release").length, 0);
  });
});

describe("Checkout.process() — 補償路徑", () => {
  it("支付被拒：release 票券、SeatMap 回 AVAILABLE、拋 TerminalError，且不確認不發信", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);

    await t.assert.rejects(
      () =>
        handlers().process(ctx, {
          ticketId: "seat-3",
          userId: "bob",
          paymentMethodId: "card_decline",
        }),
      (err: Error) => {
        // 雙層包裝：內層 TerminalError('Payment declined: …') → 外層 'Payment failed: …'
        t.assert.equal(err instanceof TerminalError, true);
        t.assert.equal(
          err.message,
          "Payment failed: Payment declined: Payment declined (Method: card_decline)"
        );
        return true;
      }
    );

    t.assert.deepStrictEqual(
      mock.objectCalls.map((c) => `${c.service}.${c.handler}`),
      ["Ticket.reserve", "SeatMap.set", "Ticket.release", "SeatMap.set"]
    );
    t.assert.deepStrictEqual(mock.objectCalls[2].args, []);
    t.assert.deepStrictEqual(mock.objectCalls[3].args, [{ seatId: "seat-3", status: "AVAILABLE" }]);
    t.assert.deepStrictEqual(mock.runs, ["process-payment"]); // 未送達 send-email
    t.assert.equal(callOf(mock.objectCalls, "confirm").length, 0);
  });

  it("閘道timeout（card_error）：同樣走補償，錯誤訊息含 Gateway timeout", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);
    await t.assert.rejects(
      () =>
        handlers().process(ctx, {
          ticketId: "seat-8",
          userId: "carol",
          paymentMethodId: "card_error",
        }),
      (err: Error) => {
        t.assert.equal(
          err.message,
          "Payment failed: Payment declined: Gateway timeout"
        );
        return err instanceof TerminalError;
      }
    );
    t.assert.equal(callOf(mock.objectCalls, "release").length, 1);
  });

  it("Step 1 预订即失败（票已售出）：不進付款、不做補償（try 之外無事務）", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock, {
      overrides: {
        Ticket: {
          reserve: () => {
            throw new TerminalError("Ticket already sold");
          },
        },
      },
    });

    await t.assert.rejects(
      () => handlers().process(ctx, { ticketId: "seat-1", userId: "dave" }),
      (err: Error) => err instanceof TerminalError && err.message === "Ticket already sold"
    );

    t.assert.deepStrictEqual(
      mock.objectCalls.map((c) => `${c.service}.${c.handler}`),
      ["Ticket.reserve"]
    );
    t.assert.deepStrictEqual(mock.runs, []);
    t.assert.equal(callOf(mock.objectCalls, "release").length, 0);
    t.assert.equal(callOf(mock.objectCalls, "set").length, 0);
  });
});
