// src/index.ts — Worker fetch 路由與 /api/mock-payment 端點單元測試。
// 註：restate endpoint 本身由鏡像 stub 記錄呼叫（見 test/loader/fake-restate-sdk.mjs）；
// 這裡斷言的是 index.ts 自己的「mock-payment 攔截、其餘委派 restateHandler」路由行為。
import { describe, it, beforeEach } from "node:test";
import worker from "../src/index";

const ENDPOINT_CALLS = "__restateEndpointCalls" as const;
function endpointCalls(): Array<{ url: string; method: string }> {
  return ((globalThis as Record<string, unknown>)[ENDPOINT_CALLS] ?? []) as Array<{
    url: string;
    method: string;
  }>;
}

function url(path: string) {
  return `https://nexus-poc.test.example${path}`;
}
function postPayment(body: unknown) {
  return new Request(url("/api/mock-payment"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const asFetch = (request: Request) => worker.fetch(request, {}, {});

describe("GET/其他路徑 → 委派 restate endpoint", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[ENDPOINT_CALLS] = [];
  });

  it("非 mock-payment 路徑一律交給 createEndpointHandler 處理", async (t) => {
    const response = await asFetch(new Request(url("/Ticket/reserve"), { method: "POST" }));
    t.assert.deepStrictEqual(endpointCalls(), [
      { url: url("/Ticket/reserve"), method: "POST" },
    ]);
    t.assert.equal(response.status, 599); // stub 標記：證明路由未走 mock-payment
  });

  it("mock-payment 路徑不觸及 restate endpoint", async (t) => {
    await asFetch(postPayment({ amount: 1, paymentMethodId: "card_success" }));
    t.assert.deepStrictEqual(endpointCalls(), []);
  });
});

describe("POST /api/mock-payment（模擬支付閘道）", () => {
  it("成功：200 + success/transactionId + X-Version: v2", async (t) => {
    const response = await asFetch(postPayment({ amount: 100, paymentMethodId: "card_success" }));
    t.assert.equal(response.status, 200);
    t.assert.equal(response.headers.get("X-Version"), "v2");
    t.assert.equal(response.headers.get("Content-Type"), "application/json");

    const body = (await response.json()) as { success: boolean; transactionId: string };
    t.assert.equal(body.success, true);
    t.assert.match(
      body.transactionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("card_decline：402 + { error: 'Insufficient funds' }", async (t) => {
    const response = await asFetch(postPayment({ amount: 50, paymentMethodId: "card_decline" }));
    t.assert.equal(response.status, 402);
    t.assert.deepStrictEqual(await response.json(), { error: "Insufficient funds" });
  });

  it("card_error：503 + { error: 'Gateway timeout' }", async (t) => {
    const response = await asFetch(postPayment({ amount: 50, paymentMethodId: "card_error" }));
    t.assert.equal(response.status, 503);
    t.assert.deepStrictEqual(await response.json(), { error: "Gateway timeout" });
  });

  it("非 POST（GET）：405 'Method not allowed'，且不解析 body", async (t) => {
    const response = await asFetch(new Request(url("/api/mock-payment"), { method: "GET" }));
    t.assert.equal(response.status, 405);
    t.assert.equal(await response.text(), "Method not allowed");
  });

  it("邊界（既有行為）：無效 JSON 的 POST 不被捕獲——fetch handler 直接拋出（正式環境由 Workers runtime 轉為 500）", async (t) => {
    const request = new Request(url("/api/mock-payment"), {
      method: "POST",
      body: "not-json",
    });
    await t.assert.rejects(() => asFetch(request), (err: Error) => err instanceof Error);
  });
});
