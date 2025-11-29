import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";

export const seatMapObject = restate.object({
    name: "SeatMap",
    handlers: {
        set: async (ctx: restate.ObjectContext, data: { seatId: string, status: string }) => {
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            map[data.seatId] = data.status;
            ctx.set("map", map);
            return true;
        },
        get: async (ctx: restate.ObjectContext) => {
            const map = (await ctx.get<Record<string, string>>("map")) || {};
            // Convert map to array format expected by frontend
            // Or just return the map and let frontend handle it.
            // For compatibility with existing frontend logic which expects array:
            return Object.entries(map).map(([id, status]) => ({ id, status }));
        }
    }
});

export type SeatMapObject = typeof seatMapObject;
