// src/game_manager.ts — GameManager.reset 批次釋放行為單元測試。
import { describe, it } from "node:test";
import { gameManager } from "../src/game_manager";
import { createMockContext, createMockState, handlersOf } from "./helpers/mocks";

const handlers = () =>
  handlersOf<{ reset: (ctx: any) => Promise<unknown> }>(gameManager, "service");

describe("GameManager.reset()", () => {
  it("先非同步重設 SeatMap(global)，再對 seat-1..seat-50 逐張發出 release", async (t) => {
    const mock = createMockState();
    const ctx = createMockContext(mock);
    t.assert.equal(await handlers().reset(ctx), undefined);

    // 共 51 個 fire-and-forget：1 個 SeatMap.reset + 50 個 Ticket.release
    t.assert.equal(mock.sendCalls.length, 51);
    t.assert.deepStrictEqual(mock.sendCalls[0], {
      service: "SeatMap",
      key: "global",
      handler: "reset",
      args: [],
    });
    const releases = mock.sendCalls
      .filter((c) => c.service === "Ticket")
      .map((c) => `${c.key}.${c.handler}`);
    const expected = Array.from({ length: 50 }, (_, i) => `seat-${i + 1}.release`);
    t.assert.deepStrictEqual(releases, expected);
  });
});
