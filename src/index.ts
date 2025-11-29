import { createEndpointHandler } from "@restatedev/restate-sdk-cloudflare-workers/fetch";
import { ticketObject } from "./ticket";
import { checkoutWorkflow } from "./checkout";

console.log("Starting worker script with createEndpointHandler...");

const restateHandler = createEndpointHandler({
    services: [ticketObject, checkoutWorkflow],
});

async function handleMockPayment(request: Request): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.json() as { amount: number; paymentMethodId: string };
    console.log(`[MockGateway] Processing payment: $${body.amount} via ${body.paymentMethodId}`);

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 500));

    if (body.paymentMethodId === "card_decline") {
        return new Response(JSON.stringify({ error: "Insufficient funds" }), {
            status: 402,
            headers: { "Content-Type": "application/json" }
        });
    }

    if (body.paymentMethodId === "card_error") {
        return new Response(JSON.stringify({ error: "Gateway timeout" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
        });
    }

    return new Response(JSON.stringify({ success: true, transactionId: crypto.randomUUID() }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Version": "v2" }
    });
}

export default {
    fetch: async (request: Request, env: any, ctx: any) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/mock-payment") {
            return handleMockPayment(request);
        }
        return restateHandler(request, env, ctx);
    },
};
