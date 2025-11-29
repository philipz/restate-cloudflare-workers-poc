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
                await ctx.objectClient(seatMapObject, "global").set({ seatId: ctx.key, status: "RESERVED" });
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
            await ctx.objectClient(seatMapObject, "global").set({ seatId: ctx.key, status: "SOLD" });
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
            await ctx.objectClient(seatMapObject, "global").set({ seatId: ctx.key, status: "AVAILABLE" });
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
            // Check if all 50 seats are SOLD
            const soldCount = Object.values(map).filter(s => s === "SOLD").length;
            if (soldCount >= 50) {
                console.log("All seats sold! Triggering auto-reset...");
                // Run as a side effect (or workflow step) to ensure it executes
                ctx.run("reset-all-seats", async () => {
                    for (let i = 1; i <= 50; i++) {
                        // Fire and forget release calls to speed up? 
                        // Or await them? Awaiting ensures order but might be slower.
                        // Since we are in a Virtual Object handler, we should probably await or spawn a workflow.
                        // For simplicity in this handler, we await.
                        // Note: This might block the SeatMap for a few seconds.
                        await ctx.objectClient(ticketObject, `seat-${i}`).release();
                    }
                });
            }

            return true;
        },
        get: async (ctx: restate.ObjectContext) => {
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            return Object.entries(map).map(([id, status]) => ({ id, status }));
        }
    }
});

export type SeatMapObject = typeof seatMapObject;
