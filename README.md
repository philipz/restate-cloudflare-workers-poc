# Nexus Ticket Booking PoC

這是一個基於 **Restate** 和 **Cloudflare Workers** 構建的分散式搶票系統 Proof of Concept (PoC)。它展示了如何使用 Durable Execution 來處理高並發的票務預訂、支付處理和補償邏輯 (Saga Pattern)。

## 🏗️ 系統架構

本專案採用 Serverless 架構，核心組件包括：

1.  **Cloudflare Workers**: 託管應用程式邏輯，提供無伺服器計算環境。
2.  **Restate**: 提供 Durable Execution 能力，負責狀態管理、服務編排和故障恢復。
3.  **Virtual Objects (Ticket)**: 
    - 負責管理每個座位的狀態 (`AVAILABLE`, `RESERVED`, `SOLD`)。
    - 利用 Restate 的序列化特性，確保同一座位在同一時間只能被一個請求處理，防止超賣。
4.  **Durable Workflows (Checkout)**:
    - 編排整個結帳流程：預留座位 -> 處理支付 -> 確認/釋放座位。
    - 實現 Saga 模式：如果支付失敗，自動執行補償邏輯（釋放座位）。

### 支付模擬 (Payment Simulation)
為了確保系統穩定性並避免外部依賴導致的延遲，系統在本地模擬支付處理邏輯 (`src/utils/payment_new.ts`)：
- **成功**: `card_success` -> 模擬 500ms 延遲後回傳成功。
- **失敗**: `card_decline` -> 拋出 "Payment declined" 錯誤 (觸發 Saga 補償)。
- **錯誤**: `card_error` -> 拋出 "Gateway timeout" 錯誤 (觸發重試或失敗)。

## 🚀 本地端開發與執行

### 前置需求
- Node.js & npm
- Docker (用於執行本地 Restate Server)
- Restate CLI (`brew install restatedev/tap/restate`)

### 1. 啟動 Restate Server
```bash
docker run --name restate_dev -d -p 8080:8080 -p 9070:9070 -p 9090:9090 docker.io/restatedev/restate:latest
```

### 2. 部署 Worker
```bash
npm install
npx wrangler deploy
```
這會將 Worker 部署到 Cloudflare，網址通常為 `https://nexus-poc.<your-subdomain>.workers.dev`。

### 3. 註冊服務到本地 Restate
```bash
curl -X POST http://localhost:9070/deployments \
  -H "Content-Type: application/json" \
  -d '{"uri": "https://nexus-poc.philipz.workers.dev"}'
```

## ☁️ 雲端架構與部署 (Restate Cloud)

本專案已部署至 **Restate Cloud**，實現完全託管的 Durable Execution 環境。

- **Restate Cloud Environment**: `nexus-poc`
- **Ingress URL**: `https://201kb7y8wxs1nk6t81wyx88dn2q.env.us.restate.cloud:8080`

### 部署步驟
1.  **登入 Restate Cloud**: `restate cloud login`
2.  **建立環境**: 在[Restate Cloud](https://cloud.restate.dev/)網頁中建立nexus-poc
3.  **配置 CLI**: `restate cloud environments configure philipz/nexus-poc`
4.  **註冊服務**:
    ```bash
    restate -e nexus-poc deployments register https://nexus-poc.philipz.workers.dev
    ```
    or
    ```bash
    curl -X POST https://201kb7y8wxs1nk6t81wyx88dn2q.env.us.restate.cloud:9070/deployments \
      -H "Authorization: Bearer $RESTATE_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"uri": "https://nexus-poc.philipz.workers.dev", "force": true}'
    ```

## 🧪 測試情境與方法

本專案提供兩個自動化測試腳本，涵蓋完整的測試場景。

### 測試場景 (Test Scenarios)

1.  **成功訂票 (Happy Path)**
    - 輸入: `paymentMethodId: "card_success"`
    - 預期: 回傳 "Booking Confirmed"，座位狀態變為 `SOLD`。
2.  **支付失敗與補償 (Saga Compensation)**
    - 輸入: `paymentMethodId: "card_decline"`
    - 預期: 回傳 "Payment declined"，座位狀態回滾為 `AVAILABLE`。
3.  **防止雙重訂票 (Double Booking)**
    - 輸入: 對同一座位連續發送兩次請求。
    - 預期: 第二次請求失敗，顯示 "Seat already sold"。
4.  **並發控制 (Concurrency)**
    - 輸入: 多個請求同時搶同一座位。
    - 預期: 恰好一個請求回傳 "Booking Confirmed"，其餘回傳 "currently reserved" 或 "already sold" 的正確拒絕（`test-all.sh` 測試 5 驗證此失敗型別分布）。

### 如何執行測試

#### 0. 自動化單元/回歸測試 (`npm test`)
不需要外部服務（使用 fake Restate SDK loader），可在任何環境執行：

```bash
npm install           # 安裝相依（wrangler 與 workers-types 的 optional peer 衝突時可加 --legacy-peer-deps）
npm test              # 全數測試（目前為 57 tests，約 1.4 秒）
npm run test:race     # 並發反例（race counterexample）專門測試
npm run test:coverage # 覆蓋率報告（node --experimental-test-coverage，零額外相依）
```

測試分層：
- **單元測試**：以 `test/helpers/mocks.ts` 的 recorder stub 驅動單一 handler。
- **整合式情境測試**（`test/integration_scenarios.test.ts`）：以 `test/helpers/integration.ts`
  把 Ticket/SeatMap/GameManager/Checkout 的**真實 handler 互接**，具備 per-key 互斥、
  fire-and-forget 延遲投遞、`ctx.run` 插隊控制點與呼叫軌跡，用於釘住跨物件競態
  （併發雙重扣款、補償幽靈可售票、TTL 逾期與邊界值等）。
- **harness 自我驗證**（`test/harness_fidelity.test.ts`）：確保上述測試基礎設施本身正確。

> **覆蓋率現況**：`src/` 各檔均為 100% line/branch/function。
> 但這**不等於**行為正確——本專案兩個真實缺陷（同 user 併發雙重扣款、
> 補償覆寫視圖造成幽靈可售票）都是在 100% 覆蓋率下才被整合式情境測試找出來的。
> 覆蓋率只代表「程式被執行過」，情境設計才決定「行為被驗證過」。

> 註：`src/utils/delay.ts` 提供可注入的模擬延遲；測試啟動時
> （`test/loader/test-setup.mjs`）將其歸零，故套件不會真的睡滿
> payment 500ms／email 200ms。正式環境行為不變。

#### 0.1 CI 閘門 (`.github/workflows/test.yml`)

PR 與 push 至 `main`／`software-factory` 時自動執行
`npm ci` → `tsc`（src 與 test 兩份設定）→ `npm test`，並附帶非阻斷的覆蓋率摘要。
需外部 Restate server 的 E2E（`test-all.sh`／`test-cloud.sh`）不在 CI 範圍內。

#### 1. 本地環境測試 (`test-all.sh`)
針對本地運行的 Restate Server (`localhost:8080`) 執行完整測試套件。

**重跑前提**:
- 本地 Restate Server 已啟動，且 Worker 服務已註冊至該实例（見上方「註冊服務」）。
- 腳本每次執行使用唯一 run 前綴（`RUN_ID` 環境變數可覆蓋）作為座位 id，並在開頭前置呼叫 `SeatMap/global/reset` 與 `Ticket/{id}/cleanup` 清理狀態，因此對持久化的 Restate 实例**可重複執行**（同一实例連跑兩次皆應全綠）。

```bash
./test-all.sh
```

#### 2. 雲端環境測試 (`test-cloud.sh`)
針對 Restate Cloud 環境執行驗證。

**設定認證**（必要）:
在專案根目錄建立 `.env` 檔案，填入您的 Restate Cloud Token。未設定 `RESTATE_AUTH_TOKEN` 時腳本會**提前以非 0 結束碼退出**：
```env
RESTATE_AUTH_TOKEN=your_token_here
```

**執行測試**:
```bash
./test-cloud.sh
```

腳本結尾會印出 PASSED/FAILED 摘要；**任一測試失敗即以 exit 1 結束**，可被自動化直接依賴結束碼判斷。

#### 3. 壓力測試 (Load Testing with K6)
模擬大量用戶搶票的高並發情境。

**測試腳本**: `load-test.js`（本地／雲端共用一份，`load-test-local.js` 為相容入口）
**情境**:
- 隨機選擇座位 (1-50，可用 `SEATS` 覆寫)
- 隨機支付結果: 80% 成功, 10% 拒絕, 10% 錯誤 (Gateway Timeout)

**門檻設計**（重要）:
- ~~`http_req_failed: rate<0.1`~~ 已移除：本測試刻意製造 10% 拒絕＋10% 逾時
  （皆由 Restate 以 HTTP 500 回傳），期望失敗率本就約 20%，該門檻必然紅燈、等於沒有訊號。
- 改用自訂指標 **`unexpected_errors`（`rate<0.01`）**：只計「非預期」回應，
  四種已知業務結果（成交／已售出或保留中／付款拒絕／閘道逾時）皆不計入。
- **`invariant_violations`（`count==0`）**：測試結束後（`teardown`）逐座位比對真值與視圖，
  檢查 I1 SOLD 必有持有者、**I2 真值 SOLD 時視圖不得為 AVAILABLE（幽靈可售票，見 Issue #22）**、
  I3 RESERVED 必有 `reservedBy`/`reservedUntil`。可用 `SKIP_INVARIANTS=1` 跳過。
- 另有 `outcome_*` 計數器輸出業務結果分佈，僅供閱讀、不設門檻。

**執行方式**:
```bash
# 本地（預設 TARGET=local，免驗證）
k6 run load-test.js
k6 run -e VUS=10 -e DURATION=60s load-test.js
k6 run load-test-local.js            # 等價於 -e TARGET=local

# 雲端（需 token）
source .env
k6 run -e TARGET=cloud -e RESTATE_AUTH_TOKEN=$RESTATE_AUTH_TOKEN load-test.js
k6 run -e TARGET=cloud -e RESTATE_AUTH_TOKEN=$RESTATE_AUTH_TOKEN -e VUS=10 -e DURATION=60s load-test.js

# 直接指定任意 ingress
k6 run -e BASE_URL=http://localhost:8080 load-test.js
```

## 📂 專案結構

- `src/game.ts`: **Virtual Objects** - 包含 `Ticket` (座位狀態) 與 `SeatMap` (座位圖聚合)
- `src/checkout.ts`: **Workflow** - 結帳流程與 Saga 補償
- `src/utils/payment_new.ts`: 支付邏輯 (本地模擬，無外部相依)
- `src/utils/email.ts`: 郵件發送邏輯 (模擬)
- `src/utils/delay.ts`: 可注入的模擬延遲（測試可歸零，正式環境行為不變）
- `src/index.ts`: 服務入口與路由
- `test/helpers/integration.ts`: 整合式測試 harness（真實 handler 互接）
- `test/integration_scenarios.test.ts`: 跨物件競態/一致性情境（S1–S6）
- `test/harness_fidelity.test.ts`: harness 自我驗證
- `.github/workflows/test.yml`: CI 閘門（typecheck ＋ npm test）
- `test-all.sh`: 本地端完整測試腳本
- `test-cloud.sh`: 雲端驗證腳本
