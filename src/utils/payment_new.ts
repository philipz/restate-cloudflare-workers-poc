export async function processPayment(amount: number, paymentMethodId: string): Promise<boolean> {
    console.log(`[DEBUG] Processing payment of $${amount} with method: ${paymentMethodId}`);

    let url = "https://httpbin.org/status/200";
    if (paymentMethodId === "card_decline") {
        url = "https://httpbin.org/status/402";
    } else if (paymentMethodId === "card_error") {
        url = "https://httpbin.org/status/503";
    }

    // Real HTTP call to external service
    const response = await fetch(url);

    console.log(`[DEBUG] Payment API Response Status: ${response.status}`);

    if (response.status === 200) {
        console.log("Payment successful");
        return true;
    }

    if (response.status === 402) {
        console.log("Payment declined by gateway");
        throw new Error(`Payment declined (Method: ${paymentMethodId}, Status: ${response.status})`);
    }

    if (response.status === 503) {
        console.log("Payment gateway timeout");
        throw new Error("Gateway timeout");
    }

    throw new Error(`Unexpected payment error: ${response.status}`);
}
