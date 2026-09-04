import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { gameManager } from "./game_manager";

// ----------------------------------------------------------------------------
// Ticket Object
// ----------------------------------------------------------------------------

export type TicketStatus = "AVAILABLE" | "RESERVED" | "SOLD";

export interface TicketState {
    status: TicketStatus;
    reservedBy: string | null;
    reservedUntil: number | null;
}

export const ticketObject = restate.object({
    name: "Ticket",
    handlers: {
        reserve: async (ctx: restate.ObjectContext, userId: string) => {
            const state = (await ctx.get<TicketState>("state")) || {
                status: "AVAILABLE",
                reservedBy: null,
                reservedUntil: null,
            };

            if (state.status === "SOLD") {
                throw new restate.TerminalError("Ticket already sold");
            }

            const now = await ctx.run("now", () => Date.now());
            // 檢查過期：若已 RESERVED 但逾期，視為過期自動釋放為 AVAILABLE
            if (state.status === "RESERVED" && state.reservedUntil && now > state.reservedUntil) {
                state.status = "AVAILABLE";
                state.reservedBy = null;
                state.reservedUntil = null;
            }

            // Issue #21：已 RESERVED 一律拒絕（含同一使用者）——不再冪等回 true，
            // 以免同 user 併發結帳同座位時兩次 reserve 各自成功造成雙重扣款。
            // 逾期的 RESERVED 已在上方分支被釋放為 AVAILABLE，此處仍為 RESERVED 者必屬有效保留。
            // 重播安全：同 invocation 的重試由 Restate journal 重放，不會重呼 handler。
            if (state.status === "RESERVED") {
                throw new restate.TerminalError("Ticket is currently reserved");
            }

            if (state.status === "AVAILABLE") {
                state.status = "RESERVED";
                state.reservedBy = userId;
                // Reserve for 15 minutes
                state.reservedUntil = now + 15 * 60 * 1000;
                ctx.set("state", state);
            }

            return true;
        },

        confirm: async (ctx: restate.ObjectContext, userId: string) => {
            const state = (await ctx.get<TicketState>("state")) || {
                status: "AVAILABLE",
                reservedBy: null,
                reservedUntil: null,
            };

            if (state.status === "SOLD") {
                // 冪等重試：僅當持有者身分相同時回傳成功，否則拋出 TerminalError
                if (state.reservedBy === userId) {
                    return true;
                }
                throw new restate.TerminalError(`Ticket already sold to another user: ${state.reservedBy}`);
            }

            // 認領守衛：必須為 RESERVED 且保留者與呼叫者一致，不再容忍 AVAILABLE 直接確認
            if (state.status !== "RESERVED" || state.reservedBy !== userId) {
                throw new restate.TerminalError(`Ticket is not reserved by user ${userId} (status: ${state.status}, reservedBy: ${state.reservedBy})`);
            }

            state.status = "SOLD";
            state.reservedBy = userId;
            state.reservedUntil = null;
            ctx.set("state", state);
            return true;
        },

        release: async (ctx: restate.ObjectContext, userId?: string) => {
            const state = (await ctx.get<TicketState>("state")) || {
                status: "AVAILABLE",
                reservedBy: null,
                reservedUntil: null,
            };

            // 若由特定使用者發起釋放（補償路徑）：僅允許保留者本人釋放非 SOLD 票券
            if (userId !== undefined) {
                if (state.status === "SOLD") {
                    return false;
                }
                if (state.reservedBy && state.reservedBy !== userId) {
                    return false;
                }
            }

            state.status = "AVAILABLE";
            state.reservedBy = null;
            state.reservedUntil = null;
            ctx.set("state", state);
            return true;
        },

        cleanup: async (ctx: restate.ObjectContext) => {
            ctx.clear("state");
            return true;
        },

        get: async (ctx: restate.ObjectContext) => {
            return (await ctx.get<TicketState>("state")) || {
                status: "AVAILABLE",
                reservedBy: null,
                reservedUntil: null,
            };
        },
    },
});

export type TicketObject = typeof ticketObject;

// ----------------------------------------------------------------------------
// SeatMap Object
// ----------------------------------------------------------------------------

export const seatMapObject = restate.object({
    name: "SeatMap",
    handlers: {
        set: async (ctx: restate.ObjectContext, data: { seatId: string, status: string }) => {
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            map[data.seatId] = data.status;
            ctx.set("map", map);

            // Auto-Reset Logic
            const soldCount = Object.values(map).filter(s => s === "SOLD").length;
            if (soldCount >= 50) {
                console.log("All seats sold! Triggering auto-reset...");

                // 1. Reset local map state immediately so frontend sees available seats
                for (let i = 1; i <= 50; i++) {
                    map[`seat-${i}`] = "AVAILABLE";
                }
                ctx.set("map", map);

                // 2. Trigger async reset via GameManager (Fire and Forget)
                // This avoids blocking the SeatMap completely
                ctx.serviceSendClient(gameManager).reset();
            }

            return true;
        },
        reset: async (ctx: restate.ObjectContext) => {
            const map: Record<string, string> = {};
            for (let i = 1; i <= 50; i++) {
                map[`seat-${i}`] = "AVAILABLE";
            }
            ctx.set("map", map);
        },
        get: async (ctx: restate.ObjectContext) => {
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            return Object.entries(map).map(([id, status]) => ({ id, status }));
        }
    }
});

export type SeatMapObject = typeof seatMapObject;
