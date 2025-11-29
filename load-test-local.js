import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

const VUS = __ENV.VUS ? parseInt(__ENV.VUS) : 5;
const DURATION = __ENV.DURATION ? __ENV.DURATION : '30s';

export const options = {
    stages: [
        { duration: '10s', target: VUS },  // Ramp up
        { duration: DURATION, target: VUS },  // Stay at target VUs
        { duration: '10s', target: 0 },  // Ramp down
    ],
    thresholds: {
        http_req_duration: ['p(95)<2000'], // 95% of requests should be under 2s (Local should be faster)
        http_req_failed: ['rate<0.1'],     // Failure rate should be less than 10%
    },
};

// Local Restate Server URL (Docker)
const LOCAL_URL = 'http://localhost:8080';

export default function () {
    // Simulate contention: VUS users fighting for 10000 seats
    const seatId = `seat-${randomIntBetween(1, 10000)}`;
    const userId = `user-${__VU}-${__ITER}`;

    // 80% success, 10% decline, 10% error
    const rand = Math.random();
    let paymentMethod = 'card_success';
    if (rand > 0.9) {
        paymentMethod = 'card_error';
    } else if (rand > 0.8) {
        paymentMethod = 'card_decline';
    }

    const payload = JSON.stringify({
        ticketId: seatId,
        userId: userId,
        paymentMethodId: paymentMethod,
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
            // No Authorization header needed for local Docker Restate by default
        },
    };

    const res = http.post(`${LOCAL_URL}/Checkout/process`, payload, params);

    const isSuccessful = res.status === 200 && res.body.includes('Booking Confirmed');
    const isSoldOut = res.status === 500 && res.body.includes('already sold');
    const isPaymentFailed = res.status === 500 && res.body.includes('Payment declined');
    const isGatewayTimeout = res.status === 500 && res.body.includes('Gateway timeout');

    check(res, {
        'status is 200 or 500': (r) => r.status === 200 || r.status === 500,
        'handled correctly': () => isSuccessful || isSoldOut || isPaymentFailed || isGatewayTimeout,
    });

    if (!isSuccessful && !isSoldOut && !isPaymentFailed && !isGatewayTimeout) {
        console.log(`Failed Request: Status=${res.status}, Body=${res.body}`);
    }

    sleep(1);
}
