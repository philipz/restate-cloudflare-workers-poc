import { delay } from "./delay";

export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
    console.log(`Sending email to ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${body}`);

    // Simulate network delay（測試可經 setDelayImpl 歸零）
    await delay(200);

    console.log("Email sent successfully");
}
