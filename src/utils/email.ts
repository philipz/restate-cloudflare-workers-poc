export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
    console.log(`Sending email to ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${body}`);

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log("Email sent successfully");
}
