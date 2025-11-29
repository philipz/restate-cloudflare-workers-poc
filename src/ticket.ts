import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";

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
