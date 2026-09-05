import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject, seatMapObject, TicketObject } from "./game";
import { processPayment } from "./utils/payment_new";
import { sendEmail } from "./utils/email";

export const checkoutWorkflow = restate.service({
    name: "Checkout",
    handlers: {
        process: async (ctx: restate.Context, request: { ticketId: string; userId: string; paymentMethodId?: string }) => {
            const { ticketId, userId, paymentMethodId = "card_success" } = request;
            console.log(`[DEBUG] Checkout process started for ticket: ${ticketId}, user: ${userId}, paymentMethod: ${paymentMethodId}`);
            const ticket = ctx.objectClient<TicketObject>(ticketObject, ticketId);
            const seatMap = ctx.objectClient(seatMapObject, "global");

            // Step 1: Reserve Ticket
            await ticket.reserve(userId);
            // Update SeatMap (View)
            await seatMap.set({ seatId: ticketId, status: "RESERVED" });

            try {
                // Step 2: Process Payment
                await ctx.run("process-payment", async () => {
                    try {
                        return await processPayment(100, paymentMethodId);
                    } catch (e) {
                        throw new restate.TerminalError(`Payment declined: ${(e as Error).message}`);
                    }
                });
            } catch (error) {
                // Step 3: Compensation
                // Issue #22：release 對「已 SOLD（或已由他人保留）」的票會回 false——
                // 此時本 saga 已不再持有該座位，若仍無條件把 view 寫回 AVAILABLE，
                // 會覆蓋買家較新的 SOLD 寫入（last-writer-wins）而產生永久性「幽靈可售票」。
                // 因此僅在確實釋放成功時才回寫視圖。
                const released = await ticket.release(userId);
                if (released) {
                    // Revert SeatMap (View)
                    await seatMap.set({ seatId: ticketId, status: "AVAILABLE" });
                }
                throw new restate.TerminalError(`Payment failed: ${(error as Error).message}`);
            }

            // Step 4: Confirm Ticket
            await ticket.confirm(userId);
            // Update SeatMap (View)
            await seatMap.set({ seatId: ticketId, status: "SOLD" });

            // Step 5: Send Email
            await ctx.run("send-email", async () => {
                await sendEmail(userId, "Booking Confirmed", `You have successfully purchased ticket ${ticketId}.`);
            });

            return "Booking Confirmed";
        },
    },
});
