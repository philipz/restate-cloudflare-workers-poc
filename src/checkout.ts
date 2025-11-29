import * as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import type { TicketObject } from "./game";
import { ticketObject } from "./game";
import { processPayment } from "./utils/payment_new";
import { sendEmail } from "./utils/email";

export const checkoutWorkflow = restate.service({
    name: "Checkout",
    handlers: {
        process: async (ctx: restate.Context, request: { ticketId: string; userId: string; paymentMethodId?: string }) => {
            const { ticketId, userId, paymentMethodId = "card_success" } = request;
            console.log(`[DEBUG] Checkout process started for ticket: ${ticketId}, user: ${userId}, paymentMethod: ${paymentMethodId}`);
            const ticket = ctx.objectClient<TicketObject>(ticketObject, ticketId);

            // Step 1: Reserve Ticket
            // This is an RPC call to the Virtual Object
            // If this fails (e.g. ticket taken), it throws a TerminalError and the workflow stops here.
            await ticket.reserve(userId);

            try {
                // Step 2: Process Payment
                // This is a side effect, so we wrap it in ctx.run
                // We use a UUID or similar from ctx as idempotency key if the payment provider supports it
                // Here we just simulate it.
                await ctx.run("process-payment", async () => {
                    // Simulate $100 payment
                    try {
                        return await processPayment(100, paymentMethodId);
                    } catch (e) {
                        // We treat this as a terminal failure (e.g. card declined) to trigger compensation
                        throw new restate.TerminalError(`Payment declined: ${(e as Error).message}`);
                    }
                });
            } catch (error) {
                // Step 3: Compensation (if payment fails)
                // We must release the ticket so others can buy it.
                // We catch the error, run compensation, then re-throw to mark workflow as failed.

                // Note: In a real app, we might want to check if the error is a "decline" (terminal) vs "system error" (retryable).
                // The processPayment utility throws "Payment declined" which we treat as terminal here for simplicity,
                // or we can let Restate retry system errors. 
                // For this PoC, we assume any error from processPayment inside ctx.run that bubbles up 
                // (after Restate's internal retries for transient errors) is a failure requiring compensation.

                await ticket.release();
                throw new restate.TerminalError(`Payment failed: ${(error as Error).message}`);
            }

            // Step 4: Confirm Ticket
            await ticket.confirm();

            // Step 5: Send Email (Side Effect)
            // We don't strictly need to compensate this if it fails, but we might want to retry.
            // Restate retries this automatically on failure.
            await ctx.run("send-email", async () => {
                await sendEmail(userId, "Booking Confirmed", `You have successfully purchased ticket ${ticketId}.`);
            });

            return "Booking Confirmed";
        },
    },
});
