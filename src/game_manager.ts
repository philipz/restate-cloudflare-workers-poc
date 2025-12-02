import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject } from "./game";

export const gameManager = restate.service({
    name: "GameManager",
    handlers: {
        reset: async (ctx: restate.Context) => {
            console.log("GameManager: Executing async reset-all-seats...");

            // 1. Reset SeatMap (View)
            ctx.objectSendClient(seatMapObject, "global").reset();

            // 2. Release all tickets (Fire and Forget)
            // This runs in the background, decoupled from SeatMap
            for (let i = 1; i <= 50; i++) {
                ctx.objectSendClient(ticketObject, `seat-${i}`).release();
            }
        }
    }
});

export type GameManager = typeof gameManager;
