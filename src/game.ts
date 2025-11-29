import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";

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

            if (state.status === "RESERVED" && state.reservedBy !== userId) {
                throw new restate.TerminalError("Ticket is currently reserved");
            }

            if (state.status === "AVAILABLE") {
                state.status = "RESERVED";
                state.reservedBy = userId;
                // Reserve for 15 minutes
                state.reservedUntil = Date.now() + 15 * 60 * 1000;
                ctx.set("state", state);
            }

            return true;
        },

        confirm: async (ctx: restate.ObjectContext) => {
            const state = (await ctx.get<TicketState>("state")) || {
                status: "AVAILABLE",
                reservedBy: null,
                reservedUntil: null,
            };

            if (state.status !== "RESERVED") {
                throw new restate.TerminalError("Ticket is not reserved, cannot confirm");
            }

            state.status = "SOLD";
            state.reservedUntil = null;
            ctx.set("state", state);
            return true;
        },

        release: async (ctx: restate.ObjectContext) => {
            const state = (await ctx.get<TicketState>("state")) || {
                status: "AVAILABLE",
                reservedBy: null,
                reservedUntil: null,
            };

            state.status = "AVAILABLE";
            state.reservedBy = null;
            state.reservedUntil = null;
            ctx.set("state", state);
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

                // 2. Trigger async reset of Ticket objects (Fire and Forget)
                // This avoids blocking the SeatMap while releasing tickets
                ctx.objectSendClient(seatMapObject, "global").resetAll();
            }

            return true;
        },
        resetAll: async (ctx: restate.ObjectContext) => {
            console.log("Executing async reset-all-seats...");

            // 1. Reset local map state
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            for (let i = 1; i <= 50; i++) {
                map[`seat-${i}`] = "AVAILABLE";
            }
            ctx.set("map", map);

            // 2. Release all tickets
            for (let i = 1; i <= 50; i++) {
                await ctx.objectClient(ticketObject, `seat-${i}`).release();
            }
        },
        get: async (ctx: restate.ObjectContext) => {
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            return Object.entries(map).map(([id, status]) => ({ id, status }));
        }
    }
});

export type SeatMapObject = typeof seatMapObject;
