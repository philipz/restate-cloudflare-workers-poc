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

### 支付 API 模擬
為了模擬真實世界的支付場景，系統整合了外部 HTTP 服務 (`httpbin.org`)：
- **成功**: `card_success` -> 呼叫 `https://httpbin.org/status/200`
- **失敗**: `card_decline` -> 呼叫 `https://httpbin.org/status/402` (觸發補償)
- **錯誤**: `card_error` -> 呼叫 `https://httpbin.org/status/503` (觸發重試或失敗)

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
    - 預期: 只有一個請求成功，其餘失敗。

### 如何執行測試

#### 1. 本地環境測試 (`test-all.sh`)
針對本地運行的 Restate Server (`localhost:8080`) 執行完整測試套件。

```bash
./test-all.sh
```

#### 2. 雲端環境測試 (`test-cloud.sh`)
針對 Restate Cloud 環境執行驗證。

**設定認證**:
在專案根目錄建立 `.env` 檔案，填入您的 Restate Cloud Token：
```env
RESTATE_AUTH_TOKEN=your_token_here
```

**執行測試**:
```bash
./test-cloud.sh
```

#### 3. 壓力測試 (Load Testing with K6)
模擬大量用戶搶票的高並發情境。

**測試腳本**: `load-test.js`
**情境**:
- 隨機選擇座位 (1-100)
- 隨機支付結果: 80% 成功, 10% 拒絕, 10% 錯誤 (Gateway Timeout)

**執行方式**:
```bash
# 確保 .env 已設定 RESTATE_AUTH_TOKEN
source .env

# 預設執行 (5 VUs, 30s)
k6 run -e RESTATE_AUTH_TOKEN=$RESTATE_AUTH_TOKEN load-test.js

# 自訂參數執行
# VUS: 並發用戶數
# DURATION: 測試持續時間
k6 run -e RESTATE_AUTH_TOKEN=$RESTATE_AUTH_TOKEN -e VUS=10 -e DURATION=60s load-test.js
```

#### 4. 本地壓力測試 (Local Load Testing)
針對本地運行的 Restate Server (`localhost:8080`) 進行測試。

**測試腳本**: `load-test-local.js`
**前置需求**: 確保本地 Restate Server 已啟動 (Docker)。

**執行方式**:
```bash
# 預設執行 (5 VUs, 30s)
k6 run load-test-local.js

# 自訂參數執行
k6 run -e VUS=10 -e DURATION=60s load-test-local.js
```

## 📂 專案結構

- `src/ticket.ts`: **Virtual Object** - 座位狀態管理
- `src/checkout.ts`: **Workflow** - 結帳流程與 Saga 補償
- `src/utils/payment.ts`: 支付邏輯 (整合 httpbin.org)
- `src/index.ts`: 服務入口與路由
- `test-all.sh`: 本地端完整測試腳本
- `test-cloud.sh`: 雲端驗證腳本
