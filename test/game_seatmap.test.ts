// src/game.ts — SeatMapObject（席位視圖）單元測試，含 50 席售罄自動重設邏輯。
import { describe, it } from "node:test";
import { seatMapObject } from "../src/game";
import { createMockContext, createMockState, handlersOf } from "./helpers/mocks";

type SeatHandler = (ctx: any, arg?: unknown) => Promise<unknown>;
const handlers = () => handlersOf<Record<string, SeatHandler>>(seatMapObject, "object");

function soldMap(count: number): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 1; i <= count; i++) map[`seat-${i}`] = "SOLD";
  return map;
}

describe("SeatMap.set()", () => {
  it("寫入單席並合併至 map，回傳 true", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);
    t.assert.equal(await handlers().set(ctx, { seatId: "seat-7", status: "RESERVED" }), true);
    t.assert.deepStrictEqual(mock.data.map, { "seat-7": "RESERVED" });
  });

  it("覆寫既有席位狀態", async (t) => {
    const mock = createMockState({ map: { "seat-1": "AVAILABLE" } });
    const ctx = createMockContext(mock);
    await handlers().set(ctx, { seatId: "seat-1", status: "SOLD" });
    t.assert.deepStrictEqual(mock.data.map, { "seat-1": "SOLD" });
  });

  it("售罄自動重設：湊滿 50 SOLD 時，本地 map 全數轉 AVAILABLE 並對 GameManager 發出 fire-and-forget reset", async (t) => {
    const mock = createMockState({ map: soldMap(49) });
    const ctx = createMockContext(mock);

    t.assert.equal(await handlers().set(ctx, { seatId: "seat-50", status: "SOLD" }), true);

    // 觸發後本地 map：seat-1..50 全部 AVAILABLE
    const map = mock.data.map as Record<string, string>;
    t.assert.equal(Object.keys(map).length, 50);
    t.assert.equal(Object.values(map).every((s) => s === "AVAILABLE"), true);
    // set 被呼叫兩次：先寫入觸發值、後寫入重設值
    t.assert.deepStrictEqual(
      mock.sets.map((s) => s.key),
      ["map", "map"]
    );
    // 透過 serviceSendClient 非同步觸發 GameManager.reset（不在同步路徑等待）
    t.assert.deepStrictEqual(mock.sendCalls, [
      { service: "GameManager", key: "", handler: "reset", args: [] },
    ]);
  });

  it("未湊滿 50 SOLD 時不觸發自動重設", async (t) => {
    const mock = createMockState({ map: soldMap(48) });
    const ctx = createMockContext(mock);
    await handlers().set(ctx, { seatId: "seat-49", status: "SOLD" });
    t.assert.equal(mock.sets.length, 1);
    t.assert.deepStrictEqual(mock.sendCalls, []);
  });
});

describe("SeatMap.reset() / get()", () => {
  it("reset：初始化 seat-1..seat-50 全 AVAILABLE，回傳 undefined", async (t) => {
    const mock = createMockState({ map: { "seat-1": "SOLD" } });
    const ctx = createMockContext(mock);
    const result = await handlers().reset(ctx);
    t.assert.equal(result, undefined);
    const map = mock.data.map as Record<string, string>;
    t.assert.equal(Object.keys(map).length, 50);
    t.assert.equal(map["seat-1"], "AVAILABLE");
  });

  it("get：map 轉為 [{id,status}] 列表；空 map 回 []", async (t) => {
    const mock = createMockState({ map: { "seat-2": "SOLD", "seat-1": "AVAILABLE" } });
    const ctx = createMockContext(mock);
    //  insertion order 反映寫入順序（既有行為）
    t.assert.deepStrictEqual(await handlers().get(ctx), [
      { id: "seat-2", status: "SOLD" },
      { id: "seat-1", status: "AVAILABLE" },
    ]);

    const emptyMock = createMockState();
    t.assert.deepStrictEqual(await handlers().get(createMockContext(emptyMock)), []);
  });
});
