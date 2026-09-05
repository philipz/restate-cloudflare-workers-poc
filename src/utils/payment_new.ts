import { delay } from "./delay";

export async function processPayment(amount: number, paymentMethodId: string): Promise<boolean> {
    console.log(`[DEBUG] Processing payment of $${amount} with method: ${paymentMethodId}`);

    // Simulate payment processing without external dependency to avoid hangs
    await delay(500); // Simulate 500ms latency（測試可經 setDelayImpl 歸零）

    if (paymentMethodId === "card_decline") {
        console.log("Payment declined by gateway");
        throw new Error(`Payment declined (Method: ${paymentMethodId})`);
    }

    if (paymentMethodId === "card_error") {
        console.log("Payment gateway timeout");
        throw new Error("Gateway timeout");
    }

    console.log("Payment successful");
    return true;
}
