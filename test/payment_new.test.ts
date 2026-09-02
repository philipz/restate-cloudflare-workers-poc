// src/utils/payment_new.ts — processPayment 單元測試（既有行為回歸防護）。
import { describe, it } from "node:test";
import { processPayment } from "../src/utils/payment_new";

describe("processPayment()（mock 支付閘道）", () => {
  it("card_success 回傳 true", async (t) => {
    t.assert.equal(await processPayment(100, "card_success"), true);
  });

  it("card_decline 丟出含方式名稱的錯誤", async (t) => {
    await t.assert.rejects(
      () => processPayment(100, "card_decline"),
      /^Error: Payment declined \(Method: card_decline\)$/
    );
  });

  it("card_error 丟出 Gateway timeout", async (t) => {
    await t.assert.rejects(() => processPayment(100, "card_error"), /^Error: Gateway timeout$/);
  });

  it(
    "邊界（既有行為）：金額完全不驗證——0、負數、非數字標識之金額照樣成功；" +
      "金額只進 log（POC 模擬閘道，決策完全取決於 paymentMethodId）",
    async (t) => {
      t.assert.equal(await processPayment(0, "anything_else"), true);
      t.assert.equal(await processPayment(-999, "card_success"), true);
    }
  );
});
