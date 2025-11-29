

# **Restate 與 Cloudflare Workers 整合之分散式票務系統 "Nexus" 架構規格書**

## **1\. 執行摘要與架構願景**

### **1.1 報告目的與範疇**

本架構規格書旨在為 "Nexus" 分散式票務與預約系統提供一份詳盡的設計藍圖，該系統被設計為一個概念驗證（Proof of Concept, PoC）應用，用以展示 **Restate** 持久化執行引擎（Durable Execution Engine）與 **Cloudflare Workers** 無伺服器邊緣運算平台整合的強大能力。本報告將深入探討如何利用 **Virtual Objects**（虛擬物件，即 Actor Model 的實作）來解決高併發下的狀態競爭問題，並利用 **Durable Workflows**（持久化工作流）來實現複雜且具備容錯能力的交易流程（Saga Pattern）。本文件不僅是技術規格的陳述，更是一份針對 AI Coding Agent 或資深工程團隊的實作指南，涵蓋了從理論基礎、API 設計、狀態管理到災難恢復策略的全方位分析。

### **1.2 無伺服器架構中的狀態管理挑戰**

隨著雲端架構向無伺服器（Serverless）典範轉移，Cloudflare Workers 等邊緣運算平台因其低延遲與高擴展性而備受青睞。然而，這類環境本質上是「無狀態」（Stateless）且「短暫」（Ephemeral）的 1。Worker 的執行實例可能隨時被銷毀，且受限於嚴格的 CPU 時間限制（通常為數毫秒至數十秒）。在傳統架構中，開發者必須依賴外部資料庫（如 PostgreSQL 或 Redis）來管理應用程式狀態，這不僅引入了顯著的網絡延遲，還在高併發場景下帶來了複雜的鎖定（Locking）與競爭條件（Race Conditions）問題。例如，在熱門演唱會售票場景中，數以萬計的請求同時爭奪同一張票券的庫存，傳統資料庫往往成為效能瓶頸。

### **1.3 Restate 的解決方案：持久化執行與虛擬物件**

Restate 透過引入「持久化執行」的概念，填補了無伺服器與有狀態應用之間的鴻溝。Restate 作為一個基礎設施層，負責攔截、記錄並管理應用程式的執行進度與狀態。當整合至 Cloudflare Workers 時，Restate 賦予了 Worker 彷彿是「長執行緒」（Long-running Process）的能力。即使 Worker 在等待外部支付閘道回應時崩潰或超時，Restate 也能透過重播（Replay）執行日誌（Journal），將 Worker 恢復至崩潰前的確切狀態，確保業務邏輯的連續性 3。

本 PoC 的核心創新在於利用 **Virtual Objects**。這是一種基於 Actor Model 的架構原語。每個 Virtual Object（例如「座位-A1」）都擁有獨立的狀態與唯一的識別碼，並且 Restate 保證針對同一 Object ID 的請求會被嚴格序列化（Serialized）執行 5。這意味著開發者無需編寫複雜的資料庫鎖定邏輯，即可在應用層面上保證庫存扣減的強一致性，徹底解決了超賣（Overselling）問題。

---

## **2\. 基礎設施與整合模式深度分析**

### **2.1 Cloudflare Workers 執行環境特性**

Cloudflare Workers 運行於 V8 Isolate 引擎之上，這與傳統的 Node.js 容器環境有顯著差異。V8 Isolate 啟動速度極快（毫秒級），但它不支援某些 Node.js 的原生模組，且對記憶體與執行時間有嚴格限制。這要求 Restate SDK 必須採用輕量級且相容於 Web Standards 的實作方式。

在整合模式中，Cloudflare Worker 扮演著 Restate Server 的「執行單元」（Execution Unit）。Worker 本身不直接處理終端使用者的 HTTP 請求，而是作為 Restate 的 Webhook 接收端。

1. **Ingress（入口）**：客戶端請求首先發送至 Restate Server。  
2. **調度（Dispatch）**：Restate 根據請求的目標服務（Service）或物件（Object），查詢其對應的 Worker URL。  
3. **喚醒與執行**：Restate 向 Worker 發送包含執行上下文（Context）與狀態（State）的二進位封包。  
4. **結果回傳**：Worker 執行邏輯，並將結果或「暫停」信號（Suspension）串流回傳給 Restate 1。

### **2.2 雙向通訊協定與掛起機制**

Restate 與 Worker 之間的通訊依賴於 HTTP/2（推薦）或 HTTP/1.1 協定。為了克服 Cloudflare Workers 的執行時間限制（例如 30 秒），Restate 實作了「掛起」（Suspension）機制。當工作流執行到 await ctx.sleep(1000) 或等待外部系統回應時，Worker 實例可以安全地終止釋放資源。當時間到達或外部系統回調時，Restate 會重新觸發一個新的 Worker 實例，並從上次暫停的地方繼續執行。這種機制使得在受限的 Serverless 環境中運行長達數天甚至數月的工作流成為可能 4。

### **2.3 部署拓撲與配置**

本 PoC 將使用 @restatedev/restate-sdk-cloudflare-workers 套件 8。部署流程涉及以下關鍵組件：

* **Wrangler**：Cloudflare 的命令列工具，用於構建與部署 Worker 9。  
* **Restate Server**：可以是自我託管的實例（Docker/K8s）或 Restate Cloud 服務 10。  
* **服務註冊（Registration）**：這是 Restate 獨有的步驟。Worker 部署後，必須顯式地向 Restate 環境註冊其 URL。Restate 會查詢 Worker 的探索端點（Discovery Endpoint），獲取服務定義（Schema）並鎖定版本 10。

| 組件 | 角色 | 職責 | 關鍵配置 |
| :---- | :---- | :---- | :---- |
| **User Client** | 發起者 | 發送購票請求 | 指向 Restate Ingress URL |
| **Restate Server** | 協調者 | 事務日誌、狀態存儲、重試排程 | 需配置 Identity Keys 以保證安全 |
| **Cloudflare Worker** | 執行者 | 執行業務邏輯（Nexus 程式碼） | wrangler.toml 需開啟 ES Module 支援 |
| **Payment Gateway** | 外部依賴 | 模擬支付處理（Stripe/PayPal） | 需透過 ctx.run 包裝以處理非決定性 |

---

## **3\. "Nexus" 票務系統情境定義與需求分析**

### **3.1 業務場景：高併發搶票**

"Nexus" 系統模擬一場熱門活動的售票過程。該場景具有兩個極端挑戰，完美的對應了 Restate 的核心特性：

1. **極致的庫存爭奪（Inventory Contention）**：數千名使用者在同一秒鐘嘗試預訂同一個座位。這需要 **Virtual Objects** 來實現序列化存取。  
2. **不可靠的支付流程（Unreliable Payment）**：使用者預訂座位後，必須在 15 分鐘內完成支付。支付過程涉及外部 API 調用，可能會超時、失敗或網路中斷。這需要 **Durable Workflows** 來管理交易狀態與補償邏輯（Saga Pattern）。

### **3.2 系統功能需求**

* **座位預留（Reservation）**：使用者可以鎖定特定座位。鎖定期間，其他使用者無法預訂。  
* **預留過期（Expiration）**：若在規定時間內未完成支付，系統必須自動釋放座位（Durable Timer）。  
* **支付處理（Payment Processing）**：呼叫外部支付閘道。若支付成功，將座位標記為「已售出」；若失敗，則觸發「補償交易」以釋放座位。  
* **通訊通知（Notification）**：支付成功後發送電子郵件確認。需保證「至少一次」（At-least-once）發送，且理想情況下透過等冪性（Idempotency）達到「恰好一次」（Exactly-once）的效果。

### **3.3 元件架構圖**

系統由三個主要的 Restate 服務/物件組成：

1. **TicketObject (Virtual Object)**  
   * **職責**：單一座位庫存的權威來源（Source of Truth）。  
   * **識別碼**：event\_id \+ seat\_id。  
   * **狀態**：status (AVAILABLE, RESERVED, SOLD), holder\_id, expiry\_timestamp。  
   * **介面**：reserve(), confirm(), release()。  
2. **CheckoutWorkflow (Durable Workflow)**  
   * **職責**：協調購票流程，管理 Saga 事務。  
   * **輸入**：user\_id, ticket\_id, payment\_info。  
   * **邏輯**：調用 TicketObject \-\> 執行支付 \-\> 確認或回滾。  
3. **UserSessionObject (Virtual Object \- Optional)**  
   * **職責**：管理使用者的購物車或活躍訂單。  
   * **識別碼**：user\_id。  
   * **狀態**：current\_order\_id。

---

## **4\. 虛擬物件規格書：TicketObject (Inventory Actor)**

### **4.1 概念模型：無鎖併發控制**

在 Restate 中，TicketObject 是庫存管理的基石。針對同一個 TicketObject key（例如 concert-1-seat-A1）的所有請求，Restate 保證它們會被放入一個「收件箱」（Inbox），並由 Cloudflare Worker **依序** 處理。這意味著在 Worker 的程式碼中，開發者可以假設自己擁有對該狀態的獨佔存取權，完全不需要使用 mutex 或資料庫交易鎖 12。

### **4.2 狀態定義 (Schema)**

我們使用 TypeScript 介面定義狀態結構。這些狀態將被序列化並存儲在 Restate 的 Key-Value Store 中。

TypeScript

type TicketStatus \= "AVAILABLE" | "RESERVED" | "SOLD";

interface TicketState {  
  status: TicketStatus;  
  reservedBy: string | null; // User ID  
  reservedUntil: number | null; // Timestamp  
}

### **4.3 API 介面與行為規範**

以下定義了 TicketObject 必須實作的方法及其行為邏輯：

#### **4.3.1 reserve(userId: string)**

* **前置條件**：無。  
* **邏輯**：  
  1. 透過 ctx.get("state") 獲取當前狀態 13。  
  2. 檢查 status。  
     * 若為 SOLD：拋出 TerminalError("Ticket already sold")。  
     * 若為 RESERVED 且 reservedBy\!= userId：拋出 TerminalError("Ticket is currently reserved")。  
     * 若為 AVAILABLE：  
       * 更新狀態：status \= RESERVED。  
       * 設定持有者：reservedBy \= userId。  
       * 設定過期時間（可選，若由 Object 自行管理 Timer）。  
       * 透過 ctx.set("state", newState) 保存變更。  
  3. 回傳：true (成功) 或拋出異常。  
* **並發保證**：由於 Virtual Object 的序列化特性，若 User A 和 User B 同時呼叫 reserve，後執行的請求必然會看到先執行請求所寫入的 RESERVED 狀態，從而失敗 6。

#### **4.3.2 confirm()**

* **邏輯**：  
  1. 獲取狀態。  
  2. 若 status 不為 RESERVED，拋出異常（資料不一致）。  
  3. 更新狀態：status \= SOLD。  
  4. 清除 reservedUntil。  
  5. 保存狀態。  
* **調用者**：僅應由 CheckoutWorkflow 在支付成功後調用。

#### **4.3.3 release()**

* **邏輯**：  
  1. 將狀態重置為 AVAILABLE。  
  2. 清除 reservedBy 和 reservedUntil。  
  3. 保存狀態。  
* **用途**：作為 Saga 的補償操作（Compensation Action），當支付失敗或使用者取消時執行。

### **4.4 狀態存取模式**

在 Cloudflare Workers 中，我們使用 ctx.get 和 ctx.set 來操作狀態。Restate 的 SDK 會在 Worker 啟動時預先載入（Prefetch）狀態，或在需要時透過網路獲取。

* **Lazy Loading**：await ctx.get("key") 是非同步的。  
* **Write Batching**：ctx.set("key", value) 不會立即發送網路請求，而是會在 Handler 執行成功結束時，與執行結果一同批次寫入 Restate Server。這保證了狀態更新的原子性（Atomicity）13。

---

## **5\. 持久化工作流規格書：CheckoutWorkflow (Saga Orchestrator)**

### **5.1 概念模型：Saga 模式**

Saga 是一種處理長事務（Long-lived Transactions）的設計模式，特別適用於分散式系統。由於我們無法在 TicketObject 和外部 Stripe API 之間建立一個 ACID 資料庫交易，我們必須使用 Saga。  
Saga 將大事務拆解為一系列的子事務（Steps）。若任何一個步驟失敗，Saga 必須依序執行「補償事務」（Compensating Transactions）來撤銷之前的操作 15。

### **5.2 工作流邏輯詳解**

CheckoutWorkflow 是一個 Restate Service（或 Virtual Object，視是否需要單例而定，此處建議使用 Service 以支援每個請求獨立執行 ID）。

#### **步驟 1: 座位預留 (RPC Call)**

* **動作**：調用 TicketObject.reserve(userId)。  
* **Restate 機制**：這是一個 RPC 調用。Restate 會在日誌中記錄此調用的參數與結果。  
* **失敗處理**：若 reserve 拋出 TerminalError（例如座位已滿），工作流應立即終止並回傳失敗給前端。此時尚未產生需補償的副作用。

#### **步驟 2: 執行支付 (Side Effect with ctx.run)**

這是最具風險的步驟，涉及外部非決定性系統（Non-deterministic System）。

* **語法**：必須使用 ctx.run 包裹 API 呼叫 4。  
* **代碼範例邏輯**：  
  TypeScript  
  const paymentResult \= await ctx.run("process-payment", async () \=\> {  
      // 這裡的代碼只會執行一次  
      const response \= await fetch("https://api.stripe.com/charge", {... });  
      return response.json();  
  });

* **重要性**：若 Worker 在 fetch 成功後但 ctx.run 返回前崩潰，Restate 會在重啟後看到日誌中已有 "process-payment" 的結果，因此會直接回傳該結果，而**不會**再次執行 fetch，從而避免重複扣款。  
* **等冪性鍵（Idempotency Key）**：為了更強的安全性，ctx.run 內部的 fetch 請求應包含一個由 Restate Context 提供的唯一 ID（如 ctx.id），以防極端情況下的網路重發。

#### **步驟 3: 決策與分支 (Branching)**

根據 paymentResult 進行判斷：

* **情境 A：支付成功**  
  * **動作 1**：調用 TicketObject.confirm()。  
  * **動作 2**：調用 ctx.run("send-email",...) 發送確認信。  
  * **結果**：回傳 "Booking Confirmed"。  
* **情境 B：支付失敗**  
  * **動作**：觸發補償邏輯。  
  * **補償**：調用 TicketObject.release()。  
  * **結果**：回傳 "Payment Failed"。

### **5.3 錯誤處理與重試策略**

Restate 預設採用無限重試（Infinite Retries）策略，這對於修復暫時性故障（如網路閃斷）非常有效。然而，對於業務邏輯錯誤（如信用卡額度不足），必須中斷重試。

* **TerminalError**：當支付閘道回傳 402 Payment Required 時，應在 ctx.run 內部或外部拋出 TerminalError。Restate 捕獲此錯誤後不會重試，而是將其拋給工作流代碼，進而觸發 catch 區塊中的補償邏輯 12。  
* **Retryable Error**：當回傳 500 Internal Server Error 或 Timeout 時，拋出普通 Error。Restate 會根據指數退避（Exponential Backoff）策略自動重試該步驟，直到成功為止。

---

## **6\. 實作指南與程式碼策略**

### **6.1 專案結構**

建議採用 Monorepo 或單一 Worker 專案結構，以便於管理共享的型別定義。

nexus-poc/  
├── src/  
│   ├── index.ts          // Cloudflare Worker 入口點  
│   ├── ticket.ts         // TicketObject 定義  
│   ├── checkout.ts       // CheckoutWorkflow 定義  
│   └── utils/  
│       ├── payment.ts    // 支付 API 封裝  
│       └── email.ts      // 郵件 API 封裝  
├── wrangler.toml         // Cloudflare 配置  
├── package.json  
└── tsconfig.json

### **6.2 wrangler.toml 關鍵配置**

為了支援 Restate SDK 並正確部署至 Cloudflare，wrangler.toml 需包含特定配置 19。

Ini, TOML

name \= "nexus-poc"  
main \= "src/index.ts"  
compatibility\_date \= "2024-04-01"

\# 確保開啟 Node.js 相容性（雖然 Restate 使用 fetch，但依賴鏈可能需要）  
node\_compat \= true

\[observability\]  
enabled \= true

### **6.3 進入點適配器 (Entry Point Adapter)**

src/index.ts 是 Worker 與 Restate 的接駁點。必須使用 @restatedev/restate-sdk-cloudflare-workers/fetch 提供的 endpoint API 7。

TypeScript

import \* as restate from "@restatedev/restate-sdk-cloudflare-workers/fetch";  
import { ticketObject } from "./ticket";  
import { checkoutWorkflow } from "./checkout";

export default {  
  // 將 Restate 處理器綁定至 Cloudflare 的 fetch 事件  
  fetch: restate.endpoint()  
   .bind(ticketObject)  
   .bind(checkoutWorkflow)  
    // 可選：設定 Request 驗證邏輯  
   .handler()  
};

此 fetch 處理器會自動處理請求的反序列化、簽章驗證（若有配置 Identity Keys）以及將執行結果序列化回傳。

### **6.4 TypeScript 型別安全策略**

Restate 提供了強大的型別推斷功能。為了確保 CheckoutWorkflow 在呼叫 TicketObject 時具有型別檢查，應匯出 Object 的 API 定義。

TypeScript

// 在 ticket.ts 中  
export const ticketObject \= restate.object({  
  name: "Ticket",  
  handlers: { /\*... \*/ }  
});  
// 匯出型別供客戶端使用  
export type TicketObject \= typeof ticketObject;

// 在 checkout.ts 中使用  
import type { TicketObject } from "./ticket";  
//...  
const ticket \= ctx.objectClient\<TicketObject\>(ticketObject, ticketId);  
await ticket.reserve(userId); // 這裡會有自動補全與型別檢查

---

## **7\. 運維卓越性與可觀測性規格 (Operational Excellence)**

### **7.1 部署與註冊流程**

部署分為兩個階段：基礎設施部署與服務註冊。這是 Restate 架構的獨特之處。

1. 部署 Worker：  
   執行 npx wrangler deploy。Cloudflare 會將程式碼分發至全球邊緣節點，並回傳一個 URL（例如 https://nexus-poc.users.workers.dev）。此時 Worker 尚未開始處理 Restate 任務。  
2. 註冊服務 (Service Discovery)：  
   執行 restate deployments register https://nexus-poc.users.workers.dev 10。  
   * Restate Server 會向該 URL 發送一個探索請求。  
   * Worker 回傳其支援的服務列表（Ticket, Checkout）及方法簽章。  
   * Restate 將此版本標記為最新，並開始將流量導向此 URL。

### **7.2 狀態版本控制與升級**

當業務邏輯變更（例如 TicketState 新增欄位）時，必須謹慎處理正在執行的工作流。

* **In-flight Workflows**：Restate 支援並行版本。舊的工作流實例可以繼續在舊版本的 Worker 上執行，而新的請求則路由至新版本。  
* **State Compatibility**：若 Virtual Object 的狀態結構發生破壞性變更（Breaking Change），建議在 ctx.get 後實作遷移邏輯（Migration Logic），例如檢查欄位是否存在並給予預設值。

### **7.3 可觀測性與除錯 (Observability)**

Restate 自動為所有調用生成分佈式追蹤（Distributed Traces）。

* **Invocation ID**：每個請求都有一個全域唯一的 ID。在 Cloudflare Logs 中，應將此 ID 包含在所有 console.log 輸出中，以便與 Restate Console 的視圖對應。  
* **Journal Inspection**：當開發者遇到 "Bug" 時，Restate 允許查看特定 Invocation 的完整執行日誌。可以看到：  
  * Ticket.reserve 在 10:00:01 成功。  
  * ctx.run("payment") 在 10:00:02 失敗。  
  * 重試發生在 10:00:05。  
    這對於除錯分佈式系統中的競爭條件與時序問題至關重要 11。

### **7.4 安全規格 (Security Specs)**

* **Identity Keys**：為了防止惡意使用者繞過 Restate 直接攻擊 Cloudflare Worker 的 fetch 端點，必須啟用 Restate Identity Keys。Worker SDK 會驗證請求標頭中的簽章，拒絕任何未經授權的來源 10。  
* **Secrets Management**：Stripe API Key 等敏感資訊必須存儲於 Cloudflare Secrets (wrangler secret put)，並透過 env 變數注入 Worker。Restate SDK 的 endpoint().handler() 產生的函數簽章為 (request, env, ctx)，可從 env 中讀取這些密鑰 2。

---

## **8\. 故障注入與復原測試計畫**

為了驗證 PoC 的堅固性，必須進行以下故障模擬測試：

| 測試場景 | 模擬方式 | 預期行為 (Expected Behavior) | 驗證指標 |
| :---- | :---- | :---- | :---- |
| **Worker 強制重啟** | 在 ctx.run 等待期間重新部署 Worker 或觸發未捕獲異常 | Restate 檢測到連線中斷，重新調度 Worker。Worker 重啟後，跳過已完成的步驟，恢復執行。 | 工作流最終狀態為 Success，且 Payment API 未被重複呼叫。 |
| **支付閘道當機 (503)** | 讓模擬的 Payment API 連續回傳 503 錯誤 | Restate 根據預設策略進行指數退避重試（例如：1s, 2s, 4s...）。 | 工作流處於 "Running" 狀態，日誌顯示多次重試紀錄。 |
| **支付閘道拒絕 (402)** | 讓模擬的 Payment API 回傳 402 | ctx.run 拋出錯誤，被 catch 區塊捕獲。執行 Ticket.release()。 | 座位狀態變回 AVAILABLE，工作流結束並回傳失敗原因。 |
| **高併發搶票** | 使用 k6 或 wrk 發送 100 個併發請求搶同一個 ticketId | Restate 將請求序列化。 | 只有 1 個請求成功，其餘 99 個請求收到「已預訂」錯誤。無超賣現象。 |

---

## **9\. AI Coding Agent 實作指令集**

為了讓 AI Coding Agent 能夠精準產出符合上述架構的程式碼，請使用以下結構化提示詞（Prompt）：

**角色設定**：你是一位精通分散式系統與無伺服器架構的資深後端工程師。

**任務**：基於 @restatedev/restate-sdk-cloudflare-workers，使用 TypeScript 實作 "Nexus" 票務系統 PoC。

**技術限制與要求**：

1. **環境**：Cloudflare Workers (Module Syntax)。  
2. **核心依賴**：@restatedev/restate-sdk-cloudflare-workers。  
3. **Virtual Object (TicketObject)**：  
   * 使用 restate.object 定義。  
   * 狀態 Schema：{ status: "AVAILABLE" | "RESERVED" | "SOLD", holder: string }。  
   * 實作 reserve(userId), confirm(), release() 方法。  
   * **關鍵邏輯**：reserve 方法必須先檢查 status，若非 AVAILABLE 則拋出 TerminalError。  
4. **Durable Workflow (CheckoutWorkflow)**：  
   * 使用 restate.service 定義。  
   * 接收 { ticketId, userId }。  
   * **Saga 流程**：  
     * Step 1: 呼叫 TicketObject.reserve (RPC)。  
     * Step 2: 使用 ctx.run 執行模擬支付（包含 50% 機率失敗的邏輯）。  
     * Step 3: 若支付失敗，捕獲錯誤並呼叫 TicketObject.release (補償)，然後拋出錯誤。  
     * Step 4: 若支付成功，呼叫 TicketObject.confirm。  
5. **組態**：產出完整的 wrangler.toml，包含 compatibility\_date 與 node\_compat 設置。

**輸出風格**：請提供包含詳細註釋的完整程式碼檔案，並解釋每個 ctx.run 與 ctx.objectClient 的使用原因。

---

## **10\. 結論**

本架構規格書詳細闡述了如何利用 Restate 與 Cloudflare Workers 構建一個具備強一致性與高容錯能力的 "Nexus" 票務系統。透過 **Virtual Objects**，我們在無狀態的邊緣環境中實現了有狀態的 Actor 模型，優雅地解決了庫存競爭問題；透過 **Durable Execution**，我們將複雜的支付流程封裝為可靠的 Saga 事務，消除了分散式系統中常見的資料不一致風險。

此 PoC 不僅展示了技術的可行性，更證明了在 Serverless 時代，開發者可以透過正確的抽象層（Restate），以同步、順序編程的簡單思維，構建出足以應對極端併發與故障的企業級分散式應用。這大幅降低了邊緣運算應用的開發門檻與維運成本，是未來雲原生架構的重要發展方向。

#### **Works cited**

1. Fetch \- Workers \- Cloudflare Docs, accessed November 29, 2025, [https://developers.cloudflare.com/workers/runtime-apis/fetch/](https://developers.cloudflare.com/workers/runtime-apis/fetch/)  
2. Fetch Handler \- Workers \- Cloudflare Docs, accessed November 29, 2025, [https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/)  
3. Show HN: Restate – Low-latency durable workflows for JavaScript/Java, in Rust | Hacker News, accessed November 29, 2025, [https://news.ycombinator.com/item?id=40659160](https://news.ycombinator.com/item?id=40659160)  
4. We replaced 400 lines of StepFunctions ASL with 40 lines of TypeScript by making Lambdas suspendable | Restate, accessed November 29, 2025, [https://restate.dev/blog/we-replaced-400-lines-of-stepfunctions-asl-with-40-lines-of-typescript-by-making-lambdas-suspendable/](https://restate.dev/blog/we-replaced-400-lines-of-stepfunctions-asl-with-40-lines-of-typescript-by-making-lambdas-suspendable/)  
5. Microservice Orchestration \- Restate, accessed November 29, 2025, [https://docs.restate.dev/get\_started/tour](https://docs.restate.dev/get_started/tour)  
6. object | Restate Typescript SDK \- GitHub Pages, accessed November 29, 2025, [https://restatedev.github.io/sdk-typescript/functions/\_restatedev\_restate-sdk.object](https://restatedev.github.io/sdk-typescript/functions/_restatedev_restate-sdk.object)  
7. accessed November 29, 2025, [https://raw.githubusercontent.com/restatedev/examples/refs/heads/main/typescript/templates/cloudflare-worker/src/index.ts?collapse\_prequel](https://raw.githubusercontent.com/restatedev/examples/refs/heads/main/typescript/templates/cloudflare-worker/src/index.ts?collapse_prequel)  
8. @restatedev/restate-sdk-cloudflare-workers \- NPM, accessed November 29, 2025, [https://www.npmjs.com/package/@restatedev/restate-sdk-cloudflare-workers](https://www.npmjs.com/package/@restatedev/restate-sdk-cloudflare-workers)  
9. Commands \- Wrangler · Cloudflare Workers docs, accessed November 29, 2025, [https://developers.cloudflare.com/workers/wrangler/commands/](https://developers.cloudflare.com/workers/wrangler/commands/)  
10. Cloudflare Workers \- Restate docs, accessed November 29, 2025, [https://docs.restate.dev/services/deploy/cloudflare-workers](https://docs.restate.dev/services/deploy/cloudflare-workers)  
11. Tour of Restate for Agents with Vercel AI SDK, accessed November 29, 2025, [https://docs.restate.dev/tour/vercel-ai-agents](https://docs.restate.dev/tour/vercel-ai-agents)  
12. A Durable Coding Agent — with Modal and Restate, accessed November 29, 2025, [https://www.restate.dev/blog/durable-coding-agent-with-restate-and-modal](https://www.restate.dev/blog/durable-coding-agent-with-restate-and-modal)  
13. State \- Restate docs, accessed November 29, 2025, [https://docs.restate.dev/develop/go/state](https://docs.restate.dev/develop/go/state)  
14. Microservice Orchestration \- Restate docs, accessed November 29, 2025, [https://docs.restate.dev/use-cases/microservice-orchestration](https://docs.restate.dev/use-cases/microservice-orchestration)  
15. Sagas \- Restate docs, accessed November 29, 2025, [https://docs.restate.dev/guides/sagas](https://docs.restate.dev/guides/sagas)  
16. Saga Pattern Made Easy \- DEV Community, accessed November 29, 2025, [https://dev.to/temporalio/saga-pattern-made-easy-4j42](https://dev.to/temporalio/saga-pattern-made-easy-4j42)  
17. Workflows \- Restate docs, accessed November 29, 2025, [https://docs.restate.dev/tour/workflows](https://docs.restate.dev/tour/workflows)  
18. The simplest way to write workflows as code \- Restate, accessed November 29, 2025, [https://restate.dev/blog/the-simplest-way-to-write-workflows-as-code/](https://restate.dev/blog/the-simplest-way-to-write-workflows-as-code/)  
19. Configuration \- Wrangler · Cloudflare Workers docs, accessed November 29, 2025, [https://developers.cloudflare.com/workers/wrangler/configuration/](https://developers.cloudflare.com/workers/wrangler/configuration/)  
20. How to handle the wrangler.toml configuration file? · cloudflare workers-sdk · Discussion \#7115 \- GitHub, accessed November 29, 2025, [https://github.com/cloudflare/workers-sdk/discussions/7115](https://github.com/cloudflare/workers-sdk/discussions/7115)