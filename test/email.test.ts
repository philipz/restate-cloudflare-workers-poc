// src/utils/email.ts — sendEmail 單元測試（既有行為：純模擬、永不失敗）。
import { describe, it } from "node:test";
import { sendEmail } from "../src/utils/email";

describe("sendEmail()（模擬郵件服務）", () => {
  it("正常呼叫 resolve 為 undefined，不拋錯", async (t) => {
    t.assert.equal(await sendEmail("user@example.com", "Subject", "Body"), undefined);
  });

  it("邊界（既有行為）：空字串/特殊字元收件人不驗證，照樣成功", async (t) => {
    t.assert.equal(await sendEmail("", "", ""), undefined);
    t.assert.equal(await sendEmail("中文主旨 <script>", "subj\r\ne", "body"), undefined);
  });
});
