import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// 統一的搶票負載測試（本地／雲端共用一份，以環境變數切換）。
//
// 為什麼要重寫 threshold：舊版用 `http_req_failed: ['rate<0.1']`，但本測試
// 刻意讓 10% 付款拒絕 + 10% 閘道逾時（皆由 Restate 以 HTTP 500 回傳），
// 期望失敗率本來就 ~20% > 10% —— 門檻幾乎必然紅燈，等於沒有訊號。
// 改為自訂 `unexpected_errors`：只計「非預期」回應（既非成功、也非四種
// 已知業務結果），業務性失敗不計入，門檻才有意義。
//
// 環境變數：
//   TARGET=local|cloud（預設 local）  BASE_URL 可直接覆寫
//   RESTATE_AUTH_TOKEN（cloud 必填）  VUS、DURATION
//   SEATS（座位數，預設 50）          SKIP_INVARIANTS=1 可跳過收尾檢查

const TARGET = __ENV.TARGET || 'local';
const CLOUD_URL = 'https://201kb7y8wxs1nk6t81wyx88dn2q.env.us.restate.cloud:8080';
const LOCAL_URL = 'http://localhost:8080';
const BASE_URL = __ENV.BASE_URL || (TARGET === 'cloud' ? CLOUD_URL : LOCAL_URL);
const AUTH_TOKEN = __ENV.RESTATE_AUTH_TOKEN || '';

const VUS = __ENV.VUS ? parseInt(__ENV.VUS) : 5;
const DURATION = __ENV.DURATION || '30s';
const SEATS = __ENV.SEATS ? parseInt(__ENV.SEATS) : 50;

// 非預期回應比率（唯一有意義的可靠度門檻）
const unexpectedErrors = new Rate('unexpected_errors');
// 業務結果分佈（供報告閱讀，不設門檻）
const bookingConfirmed = new Counter('outcome_booking_confirmed');
const soldOut = new Counter('outcome_already_sold');
const paymentDeclined = new Counter('outcome_payment_declined');
const gatewayTimeout = new Counter('outcome_gateway_timeout');
// 收尾不變量違規數（必須為 0）
const invariantViolations = new Counter('invariant_violations');

export const options = {
    stages: [
        { duration: '10s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
    ],
    thresholds: {
        // 延遲門檻：雲端放寬（跨網路），本地較嚴
        http_req_duration: [TARGET === 'cloud' ? 'p(95)<5000' : 'p(95)<2000'],
        // 非預期回應必須極少（業務性 500 不計入）
        unexpected_errors: ['rate<0.01'],
        // 收尾一致性檢查不得有任何違規
        invariant_violations: ['count==0'],
    },
};

function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (AUTH_TOKEN) {
        h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    }
    return h;
}

export function setup() {
    if (TARGET === 'cloud' && !AUTH_TOKEN) {
        throw new Error('TARGET=cloud 需要 RESTATE_AUTH_TOKEN');
    }
    return { baseUrl: BASE_URL };
}

export default function () {
    const seatId = `seat-${randomIntBetween(1, SEATS)}`;
    const userId = `user-${__VU}-${__ITER}`;

    // 80% success, 10% decline, 10% error
    const rand = Math.random();
    let paymentMethod = 'card_success';
    if (rand > 0.9) {
        paymentMethod = 'card_error';
    } else if (rand > 0.8) {
        paymentMethod = 'card_decline';
    }

    const res = http.post(
        `${BASE_URL}/Checkout/process`,
        JSON.stringify({ ticketId: seatId, userId, paymentMethodId: paymentMethod }),
        { headers: headers() }
    );

    const body = res.body || '';
    const isSuccessful = res.status === 200 && body.includes('Booking Confirmed');
    // 已售出／保留中：皆為正確的併發拒絕
    const isSoldOut = res.status === 500 && (body.includes('already sold') || body.includes('currently reserved'));
    const isPaymentFailed = res.status === 500 && body.includes('Payment declined');
    const isGatewayTimeout = res.status === 500 && body.includes('Gateway timeout');

    if (isSuccessful) bookingConfirmed.add(1);
    if (isSoldOut) soldOut.add(1);
    if (isPaymentFailed) paymentDeclined.add(1);
    if (isGatewayTimeout) gatewayTimeout.add(1);

    const handled = isSuccessful || isSoldOut || isPaymentFailed || isGatewayTimeout;
    unexpectedErrors.add(!handled);

    check(res, {
        'response is a known business outcome': () => handled,
    });

    if (!handled) {
        console.error(`Unexpected response: status=${res.status} body=${body.slice(0, 300)}`);
    }

    sleep(1);
}

// 收尾不變量：負載結束後逐座位比對「真值 vs 視圖」。
// 抓的是壓力下才會浮現的狀態不一致（例如補償覆寫視圖造成的幽靈可售票）。
export function teardown(data) {
    if (__ENV.SKIP_INVARIANTS === '1') {
        return;
    }
    const viewRes = http.post(`${data.baseUrl}/SeatMap/global/get`, '{}', { headers: headers() });
    let view = [];
    try {
        view = JSON.parse(viewRes.body || '[]');
    } catch (e) {
        console.error(`SeatMap/global/get 回應無法解析：${viewRes.status} ${viewRes.body}`);
        invariantViolations.add(1);
        return;
    }
    const viewById = {};
    for (const entry of view) {
        viewById[entry.id] = entry.status;
    }

    for (let i = 1; i <= SEATS; i++) {
        const seatId = `seat-${i}`;
        const res = http.post(`${data.baseUrl}/Ticket/${seatId}/get`, '{}', { headers: headers() });
        let truth;
        try {
            truth = JSON.parse(res.body || '{}');
        } catch (e) {
            console.error(`Ticket/${seatId}/get 回應無法解析：${res.status} ${res.body}`);
            invariantViolations.add(1);
            continue;
        }

        // I1：SOLD 必須有唯一持有者
        if (truth.status === 'SOLD' && !truth.reservedBy) {
            console.error(`I1 violated: ${seatId} 為 SOLD 但無 reservedBy`);
            invariantViolations.add(1);
        }
        // I2：視圖不得把已售出座位顯示為可售（幽靈可售票，見 Issue #22）
        if (truth.status === 'SOLD' && viewById[seatId] === 'AVAILABLE') {
            console.error(`I2 violated: ${seatId} 真值 SOLD 但視圖 AVAILABLE（幽靈可售票）`);
            invariantViolations.add(1);
        }
        // I3：RESERVED 必須有保留者與到期時間
        if (truth.status === 'RESERVED' && (!truth.reservedBy || !truth.reservedUntil)) {
            console.error(`I3 violated: ${seatId} 為 RESERVED 但缺 reservedBy/reservedUntil`);
            invariantViolations.add(1);
        }
    }
}
