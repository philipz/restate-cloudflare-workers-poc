# Quint 正規驗證導入可行性報告（Issue #11）

- **工作項**：agent-analyze／Issue #11「分析導入 Quint 正規驗證的可行性」
- **Repo**：`agent-playground/restate-cloudflare-workers-poc`（trunk：`software-factory`）
- **日期**：2026-09（以下實測環境：Node v22.21.1、npm 10.9.4、quint（`@informalsystems/quint`）v0.32.0、Apalache 0.56.1、OpenJDK 17.0.20）
- **性質**：分析報告，**無任何程式碼／設定變更**；依工廠 SOP，報告落於 `docs/research/`（Issue PRD 建議的 `docs/quint-feasibility-report.md` 路徑與 SOP 慣例不同，採 SOP 路徑，實質範圍不變）。
- **本報告不具放行效力**（docs/06 §4），供人類審查後決定是否據以開工。

---

## 1. 結論摘要（一頁）

**可行性判定：可行，且建議「針對性導入」（方案 B）**。本次已在沙箱中以真實工具鏈完成端到端驗證：Quint 能在 **~150 行模型、零 repo 相依變更** 的前提下，把本 PoC「搶票 → 付款 → 補償 → 售出 → 售罄重置」核心流程的跨物件併發競態**機械化地找到反例**，並驗證修復方向能使不變量通過。

關鍵發現（均有可重現命令與反例為證，見 §2）：

| # | 發現 | 證據 |
|---|------|------|
| F1 | **同回合雙重成交**：auto-reset（fire-and-forget）可在 A 的 saga in-flight 時無條件釋放其保留票；B 接手付款成交後，A 的 `confirm()` 仍回傳成功 → 兩個使用者都拿到「Booking Confirmed」 | Quint `verify`（Apalache，BMC 深度 10）**窮盡反例**；`run`（模擬器）多随机種子重現 |
| F2 | **已付款者失去票**：`confirm()` 從 `AVAILABLE` 直接轉 `SOLD`（程式註解自認「與 reset 賽兵」），且 `Sold` 時**冪等回 true 不認領呼叫者** | 同上，不變量 `inv_paid_implies_owner` 違反反例 |
| F3 | **付款重試語意與宣稱不符**：README/PoC 宣稱「不可靠支付→Durable Execution 重試」，實作把**所有**支付錯誤（含 503 超時）包成 `TerminalError` → 永不重試、立即補償 | 程式碼路徑（checkout.ts:22-28）＋設計文件對照（PoC.md:64） |
| F4 | **15 分鐘保留 TTL 是死狀態**：`reservedUntil` 只寫不讀，過期不釋放 | 全 repo grep：無任何讀取路徑（game.ts:39 寫入） |
| F5 | 既有 37 個單元測試**全綠但仍放過上述競態**；其中一組測試還把 F2 的放寬路徑固定為預期行為（game.test.ts:94） | `npm test`：37 pass／0 fail |

**修復方向已被模型驗證**：加入兩條守衛（F1+F3：`confirm` 需認領呼叫者；F2：reset 與 in-flight saga 串行化（quiescence））後，模擬器 4 種子 × 25 步與 **Apalache BMC 深度 8 均無反例**。

**成本**：本次「盤點＋建模＋驗證＋反例＋修復方向」全程約一個工作項的時程；CI 端 `quint typecheck + run` 為秒級，`quint verify`（Apalache）深度 8 約 **5.2 分鐘**（建議離峰/按需跑）。主要風險是**模型與程式碼雙寫漂移**，以「模型錨定到 handler 註解＋每季重審」控制。

---

## 2. 證據與根因

### 2.1 Repo 盤點（狀態流程相關模組）

| 檔案 | 角色 | 狀態／併發關注點 |
|---|---|---|
| `src/game.ts:16-95` | `Ticket` 虛擬物件（Restate Virtual Object，per-key 串行） | `AVAILABLE/RESERVED/SOLD` 狀態機、`reservedBy`、`reservedUntil` |
| `src/game.ts:103-141` | `SeatMap` 虛擬物件（key=`global`，前端視圖） | `map[seatId]`、**`soldCount>=50` 自動重置**（:112-125） |
| `src/checkout.ts:6-48` | Checkout saga（service handler） | 保留→`ctx.run` 付款→失敗補償→確認→發信；跨物件呼叫（非 Transactional outbox） |
| `src/game_manager.ts:4-20` | 重置編排器（service） | **fire-and-forget**：`SeatMap.reset` ＋ 50 張票逐一 `release` |
| `src/index.ts:12-41` | Mock 支付閘道 | 三種結果：成功／402 decline／503 timeout |
| `src/utils/payment_new.ts`、`src/utils/email.ts` | 外部效應模擬 | 500ms／200ms 延遲；抛錯型別決定 Restate 重試與否 |

**核心流程選定**：`Checkout × Ticket × SeatMap × GameManager` 四者交織——正是「跨元件、事件驅動、重試/恢復」單元測試最難覆蓋的部分，也是 Issue PRD 要求的「至少一個代表性流程」。其餘（email、mock gateway 路由）為單點線性邏輯，形式化收益低。

### 2.2 工具鏈導入條件（實測）

| 項目 | 結果 |
|---|---|
| 安裝 | `npm i @informalsystems/quint`（本機 temp，6 秒、79 套件）；官方支援 npm/brew/nix/binaries（[getting-started](https://quint.sh/docs/getting-started)）。注意：npm 上裸名 `quint` 是**無關同名套件**（JS helpers，v1.2.0），必須用 scope 名 `@informalsystems/quint` |
| Node 需求 | v22.21.1 實測全功能可用（typecheck/run/verify）；無 native build 步驟 |
| 執行寫入需求 | `quint run` 首次執行會在 `$HOME/.quint` 下載編譯 rust evaluator、`quint verify` 會自動下載 Apalache（需 Java 17+）。沙箱/CI 需**可寫 HOME＋首次執行需網路**（或預先快取） |
| 驗證模式 | ①`quint run`：隨機模擬（本次 ~26-36 traces/s）；②`quint verify`：Apalache BMC（深度 8 耗時 309s @ 7 變數模型）；③時序性質（`--temporal`）存在但需 fairness 假設，本次未啟用 |
| 與 TS/Workers 對照 | 虛擬物件 state（`ctx.get/set`）→ `var`；handler → `action`（守衛＝拋錯路徑的反面）；`ctx.run` 日誌化步驟 → 以「階段變數＋重試自環」抽象；fire-and-forget send → 環境非決定動作（投遞順序由調度器决定）；per-key 串行 → 同一 action 原子更新（無需在 key 內建模鎖） |
| 語法限制（影響本 case 很小） | 無字串處理、無巢狀 `match`、`all{}` 中**每個 var 必須賦值**（frame 樣式Verbose）、`Set.forall` 而非 `Set.all`、`verify` 無 `--bound` 旗標（用 `--max-steps`） |
| 對齊 risk-paths | 本分析**未改動任何 src/test/CI 檔案**；`src/utils/payment_new.ts` 不匹配 H2 glob（`src/payment/**`、`**/*invoice*`），未觸碰高風險路徑 |

### 2.3 基準線（不跑需外部服務的 E2E）

```
npm ci && npm test   →  # pass 37 / # fail 0   （node:test + mock Restate context）
```

37 測試全綠——**但 F1/F2 競態在此測試集下不可見**：單元測試以單 handler ＋ mock ctx 驅動，無法產生「reset 投遞視窗插入 in-flight saga」的交錯；整合層 `test-all.sh` 依賴本地 restate-server 單線程腳本，同樣不決定性觸發。

### 2.4 模型與機械驗證結果

模型：`checkout.qnt`（BUGGY，忠於現有程式碼語意）／`checkoutFixed.qnt`（修復方向）——全文見附錄 A。抽象層級：1 張代表票（對稱性）、2 使用者、`gameOver` 以環境非決定動作抽象 sold-out 觸發＋fire-and-forget 延遲、epoch 變數區分「回合重置屬正當語意」與「同回合內被搶」（第一版不變量未加 epoch 時模擬器即找到**偽反例**，據以修正——這正是形式化的糾錯回饋速度）。

**不變量與結果**（完整命令見附錄 B）：

| 性質 | 內容 | checkout（BUGGY） | checkoutFixed |
|---|---|---|---|
| P1 `inv_no_double_sale` | 同回合 ≤1 個 Done | ❌ `run` 反例（seed 0x2a/0x77）；❌ **Apalache 窮盡反例**（depth≤10） | ✅ run 4 seeds 無反例；✅ Apalache depth 8 無違反（309s） |
| P2 `inv_paid_implies_owner` | 同回合成交者仍持有票 | ❌ 同上 | ✅ 同上 |
| P3 `inv_view_consistent` | 視圖 AVAILABLE ⇒ 真值非 SOLD | ⚪ 模型不可違反（見 §2.6 限制） | ⚪ 同左 |
| P4（意圖）重試最終成功 | ctx.run 瞬時失敗後可達 Done | 以 `transientRetries` 界＋模擬佐證（時序性質需 fairness，列下一步） | 同左 |

**Apalache 反例摘要（P2，BUGGY，可直接對映回程式碼）**：

| 狀態 | 事件 | 對應程式碼 |
|---|---|---|
| S2 | A `reserve` → `Reserved(buyer=A)`，A 進入 Paying | checkout.ts:16 / game.ts:19-44 |
| S3 | 付款瞬時失敗 ×1（重試） | checkout.ts:22（`ctx.run` 語意） |
| S4-S6 | **gameOver 連發**：無條件 `release` 把 A 的保留清掉，A 的 saga 全然不知 | game.ts:112-125 → game_manager.ts:15-17 → game.ts:68-80 |
| S7-S9 | B `reserve` 成功並付款（Paid）；A 的付款也在此時成功（Paid）——**兩個 saga 都自認持有** | checkout.ts:16-28 |
| S10 | B `confirm` → `Sold(buyer=B)`，B=Done | game.ts:46-66 |
| S11 | A `confirm` → 已 SOLD 分支**冪等回 true**（不檢查 buyer）→ A=Done。**同回合 A、B 雙成交，且 A 不持有票** | game.ts:53-55 |

修復版把 `confirm` 加認領守衛（`ticketBuyer == u`，含冪等分支）＋ `gameOver` 加 quiescence 守衛（無 Paying/Paid in-flight 才重置）後，P1/P2 於 BMC 深度 8 窮盡通過。

### 2.5 根因清單

- **RC1｜release 無條件覆蓋**（game.ts:68-80）：不檢查現行狀態與持有者，被「補償」與「批次重置」兩條路徑共用 → 可釋放到別人的 `RESERVED`，甚至 `SOLD`。
- **RC2｜confirm 無 caller 身分**（game.ts:46-66）：`confirm()` 不帶 userId；`RESERVED`（哪怕是別人留的）與 `AVAILABLE` 都直接過；`SOLD` 冪等回 true 不認領。註解（:57「in case of race with reset」）顯示**賽兵是被知道並放寬的**，但模型證明放寬後果為雙重成交。
- **RC3｜fire-and-forget 重置無序列化**（game.ts:122-124、game_manager.ts:11-17）：`serviceSendClient.reset()` 與 50 張 `release` 均為非同步投遞，與任何 in-flight Checkout saga 沒有順序/歸屬協調。
- **RC4｜錯誤分級與宣稱相反**（checkout.ts:23-27）：`catch → throw TerminalError` 把 503/timeout 等**可重試**錯誤升級為终止 → 「重試最終成功」性質在實作上不可達；設計文件（PoC.md:64、docs/deepwiki/Durable-Execution-&-ctx.run.md 的 TerminalError vs Retryable 對照）與實作矛盾。
- **RC5｜TTL 死狀態**（game.ts:39 寫入、全 repo 無讀取）：15 分鐘保留僅存在欄位，無過期釋放路徑；保留的有効期實際由「saga 必然走完（成功或補償）」這個 Restate 性質**碰巧**掩護。

### 2.6 建模限制（誠實記錄）

1. **P3 在此抽象層不可違反**：模型把 `SeatMap.set` 寫成與真值同步的原子步驟；真實的「幽靈可售票」來自**兩物件間訊息延遲**（set(SOLD) 與 reset 重寫 map 的到达順序）。要驗證需加訊息佇列（`pendingView: Set[ViewWrite]`）——Quint 勝任，但屬下一輪迭代（工作項 N4）。
2. `confirm` 覆蓋他人保留時，程式碼**不更新 `reservedBy`**（A 拿到「Booking Confirmed」但票主欄仍是 B）；模型簡化為 `buyer'=u`。兩個版本都會讓 A、B 同時收到成功回應，違反結論不變；報告如實記錄此差異。
3. 50 張票→1 張代表票為**對稱性抽象**：對 safety 反例發現是保守的（少票＝少交錯），但對「湊滿 50」觸發條件本身的驗證不在此模型內。
4. 未建模 restate-server 的持久化/重播細節（exactly-once journaling）；模型驗證的是**應用層狀態機 + 投遞順序**這一層，與 Restate 官方對 workflow semantics 的保證正交。

---

## 3. 影響範圍

- **受影響模組**：`src/game.ts`（Ticket、SeatMap 兩物件）、`src/checkout.ts`、`src/game_manager.ts`；連動 `test/game.test.ts:94`（把 RC2 放寬路徑固定為預期）需一併重新錨定。
- **使用者可見後果**：搶票高峰＋臨近售罄回合重置窗口時——①同一票雙人成交（款已收、票不可得或互撕）；②已付款使用者被 reset 沒收後仍見「Booking Confirmed」；③前端座位顯示與票真值長期漂移（P3 路徑）。對票務類應用屬資損＋客訴級；對本 PoC（遊戲化搶票）損害較低，但**作為 Restate 示範碼會輸出錯誤的併發心智模型**，這是 meta 層面的最大影響。
- **測試盲區**：37 全綠的單元測試只能證明「單 handler 決策表」正確，無法覆蓋跨物件交錯（§2.3）；load-test 腳本（`load-test*.js`）為隨機壓力，非決定性、不縮小反例。
- **下游/部署**：`wrangler.toml` 雙環境（prod/test）共用同一 endpoint handler；`docs/deepwiki/SeatMap-Virtual-Object.md` 等文件描述的「sophisticated auto-reset」未提及競態——文件與實作需同步更新。
- **風險路徑**：全部修復動作落在 `src/*.ts` 與 `test/*`，**不觸碰 `.github/**`、`catalog-info.yaml`、CODEOWNERS（H5）**；`payment_new.ts` 不在 H2 glob 內。建立 Quint CI workflow 屬 CI 設定變更 → 依停手規則须人類執行（見 §5 N5）。

---

## 4. 方案比較

| 方案 | 內容 | 成本 | 收益 | 判定 |
|---|---|---|---|---|
| **A. 不導入**，以壓力/整合測試取代 | load test 加大併發、補整合測試 | 低 | 對 F1/F2 這類**窄時窗交錯**命中靠運氣，不可重現即難修復 | ❌ 拒：§2.3 實證——37 綠仍漏 bug |
| **B. 針對性導入（建議）** | 僅 Checkout×Ticket×SeatMap×GameManager 一個 Quint 模型（~150 行）＋ P1/P2/P3 三不變量；CI 以 `quint typecheck`＋`quint run`（1k traces，秒級）做 PR 閘門；`quint verify`（Apalache depth 8-10）夜間/按需；模型檔置 `specs/`（新目錄，非 H 路徑）；修復 RC1-RC5 的工作項以「模型綠」為額外驗收 | 中（首輪 ≈1 工作項，已完成可行性實證；維護＝雙寫錨定＋季審） | 反例機械可重現（seed＋命令）；修復方向已驗證 | ✅ **採** |
| **C. 全面形式化** | 4 物件/服務全建模＋時序性質進 PR 閘門 | 高（50-seat map 狀態空間需對稱性/界限工程；epoch 等無界 int 需顯式界；depth 8 已 5.2 分鐘，PR 閘門難以承受） | 覆蓋 email/路由等低風險面 | ⏸ 緩：超出 PoC 價值；PRD §4 亦明示「不包含所有流程」 |
| 替代：直接 TLA+/Apalache | 免 Quint 轉譯層 | 無模擬器 UX、型別檢查；團隊需另學 TLA+ | 與本 repo 的 TS 開發流程整合更弱 | ❌ 拒（Quint 即 Apalache 前端：較佳的編寫體驗＋型別檢查＋模擬器，同得 SMT 後端） |
| 替代：P 語言（Microsoft） | 併發狀態機+實作產生 | 生態與本 repo 無交集、無雲端 CI 慣例 | — | ❌ 拒 |
| 替代：Model-based testing（Quint 生成測試序列） | 把反例 trace 餵給現有 node:test mock 框架 | 低-中 | 不獨立於方案 B，屬其延伸 | ➕ 併入 N4 |

**方案 B 風險與緩釋**：模型-程式碼漂移（緩釋：模型註解行號錨定＋每次改 `game.ts/checkout.ts` 的工作項驗收要求重跑 `quint run`）；CI 需 Java/網路首次快取（緩釋：`setup-java`＋`~/.quint` cache；見 N5）；不確定性質（liveness）需 fairness 假設，先以「重試界限＋模擬 witness」近似，時序驗證列入長期項。

---

## 5. 建議下一步（可直接開成工作項；人類審查後放行）

> 本報告僅產出分析與方案，不含實作。以下每項均為獨立工作項草案。

**N1 [agent-fix-bug] 修復 RC1/RC2/RC3：confirm 認領＋release 守衛＋reset 串行化**
- 描述：`Ticket.confirm` 增加持有者檢查（以 Restate 呼叫端身分或參數傳入 `userId`，含 `SOLD` 冪等分支需 `reservedBy==userId`）；`Ticket.release` 僅接受持有者或系統重置標記；`GameManager.reset` 改為對 in-flight 安全（quiescence 檢查或逐票「保留中且過期才釋」語意）。
- 驗收：①重現反例（附錄 B 命令的 P1/P2）在新增的交錯整合測試上紅→綠；②`test/game.test.ts:94` 的「容忍 AVAILABLE」斷言收緊；③既有 37 測試不減；④修復版 Quint 模型（附錄 A.2）與實作行為一致（人類抽查）。
- 風險備註：涉付款成功後的所有權判定 → 建議人類先定規格（語意＝「已收款必得票」vs「重置回合可退券」），再交 agent。

**N2 [agent-fix-bug] 修復 RC4：支付錯誤分級（可重試 vs 终止）**
- 描述：區分 `card_decline`（402，業務拒付→`TerminalError`→補償）與 `card_error`/503/超時（瞬時→原樣抛出讓 `ctx.run` 重試，配最大重試次數後備路徑）。
- 驗收：①503 情境下 `ctx.run` 產生 `RETRYABLE_ERROR` journal 並最終成功（既有 mock 測試可斷言呼叫次數）；②模型 P4 由「意圖」升級為實作斷言；③不觸碰金流金額邏輯（僅錯誤分級）。

**N3 [agent-write-docs] 處置 RC5（TTL 死狀態）**
- 描述：二擇一——(a) 實作過期釋放（`reserve` 時 `ctx.scheduleWakeAfter(15m)` 或 deferred action）；(b) 明確移除 15 分鐘宣稱並改寫 PoC.md:64/README 以反映「由 saga 完成性保證保留長度」。
- 驗收：文件與實作一致（grep `reservedUntil` 讀取路徑為證或文件不再宣稱 TTL）。

**N4 [agent-analyze→agent-add-tests] P3 訊息級模型＋反例轉整合測試**
- 描述：模型升級：SeatMap 寫入改經 `pendingView` 佇列（驗證幽靈可售票）；把 Apalache 反例 `.itf.json` 序列翻成 node:test 交錯場景（model-based testing 雛形）。
- 驗收：①新模型上 P3 可被 BUGGY 違反/修復版通過；②對應整合測試紅→綠於 N1 合併後。

**N5 [infra，人類執行] Quint CI workflow**
- 描述：PR 閘門：`quint typecheck`＋`quint run --max-steps=25 --seed=<fixed>`（秒級）；夜間：`quint verify --max-steps=8~10`（≈5 分鐘，`setup-java@17`、快取 `~/.quint`、CI 需可寫 HOME）。依停手規則 3（CI 設定變更），由人類開 workflow 檔；agent 僅可提供片段。
- 驗收：CI 綠；反例 artifact（itf.json）上傳。

---

## 附錄 A：最小模型

### A.1 `checkout.qnt`（BUGGY 語意，quint 0.32.0 typecheck 通過）

```quint
module checkout {
  type Status = Available | Reserved | Sold
  type Phase = Idle | Paying | Paid | Done | Failed
  pure val Users: Set[str] = Set("A", "B")

  var ticketStatus: Status   // Ticket 虛擬物件真值（game.ts）
  var ticketBuyer: str       // reservedBy（"" = 無）
  var viewStatus: Status     // SeatMap 檢視（game.ts）
  var userPhase: str -> Phase
  var transientRetries: int
  var epoch: int             // 遊戲回合（gameOver 遞增）
  var purchasedAt: str -> int

  action init: bool = all {
    ticketStatus' = Available, ticketBuyer' = "", viewStatus' = Available,
    userPhase' = Users.mapBy(u => Idle), transientRetries' = 0,
    epoch' = 0, purchasedAt' = Users.mapBy(u => 0),
  }

  // checkout.ts:16 → game.ts:19-44 Ticket.reserve（per-key 串行 → 原子）
  action reserve(u: str): bool = any {
    all { userPhase.get(u) == Idle, ticketStatus == Sold,
          userPhase' = userPhase.put(u, Failed),
          ticketStatus' = ticketStatus, ticketBuyer' = ticketBuyer,
          viewStatus' = viewStatus, transientRetries' = transientRetries,
          epoch' = epoch, purchasedAt' = purchasedAt },
    all { userPhase.get(u) == Idle, ticketStatus == Reserved, ticketBuyer != u,
          userPhase' = userPhase.put(u, Failed),
          ticketStatus' = ticketStatus, ticketBuyer' = ticketBuyer,
          viewStatus' = viewStatus, transientRetries' = transientRetries,
          epoch' = epoch, purchasedAt' = purchasedAt },
    all { userPhase.get(u) == Idle,
          any { ticketStatus == Available,
                all { ticketStatus == Reserved, ticketBuyer == u } },
          ticketStatus' = Reserved, ticketBuyer' = u,
          viewStatus' = Reserved,               // checkout.ts:18
          userPhase' = userPhase.put(u, Paying),
          transientRetries' = transientRetries, epoch' = epoch,
          purchasedAt' = purchasedAt },
  }

  // 意圖：ctx.run 瞬時失敗 → Restate 重試（checkout.ts:22-28）
  action payTransient(u: str): bool = all {
    userPhase.get(u) == Paying, transientRetries < 3,
    transientRetries' = transientRetries + 1, userPhase' = userPhase,
    ticketStatus' = ticketStatus, ticketBuyer' = ticketBuyer,
    viewStatus' = viewStatus, epoch' = epoch, purchasedAt' = purchasedAt,
  }

  // 實際：錯誤一律 TerminalError → 補償（checkout.ts:24-35）；release 無身分檢查（game.ts:68-80）
  action payTerminal(u: str): bool = all {
    userPhase.get(u) == Paying,
    ticketStatus' = Available, ticketBuyer' = "", viewStatus' = Available,
    userPhase' = userPhase.put(u, Failed),
    transientRetries' = transientRetries, epoch' = epoch, purchasedAt' = purchasedAt,
  }

  action paySuccess(u: str): bool = all {
    userPhase.get(u) == Paying, userPhase' = userPhase.put(u, Paid),
    ticketStatus' = ticketStatus, ticketBuyer' = ticketBuyer,
    viewStatus' = viewStatus, transientRetries' = transientRetries,
    epoch' = epoch, purchasedAt' = purchasedAt,
  }

  // checkout.ts:38-40 → game.ts:46-66（無 caller 身分；Sold 冪等 true；見 §2.6.2）
  action confirm(u: str): bool = all {
    userPhase.get(u) == Paid,
    userPhase' = userPhase.put(u, Done),
    purchasedAt' = purchasedAt.put(u, epoch),
    viewStatus' = Sold,                         // checkout.ts:40
    transientRetries' = transientRetries, epoch' = epoch,
    any {
      all { ticketStatus == Sold, ticketStatus' = Sold, ticketBuyer' = ticketBuyer },
      all { ticketStatus != Sold, ticketStatus' = Sold, ticketBuyer' = u },
    },
  }

  // game.ts:112-125 → game_manager.ts:11-17（fire-and-forget、unconditional release）
  action gameOver: bool = all {
    ticketStatus' = Available, ticketBuyer' = "", viewStatus' = Available,
    epoch' = epoch + 1, userPhase' = userPhase,
    transientRetries' = transientRetries, purchasedAt' = purchasedAt,
  }

  action step: bool = {
    nondet u = Users.oneOf()
    any { reserve(u), payTransient(u), payTerminal(u), paySuccess(u), confirm(u), gameOver }
  }

  val inv_no_double_sale: bool =                 // P1
    Users.filter(u => userPhase.get(u) == Done and purchasedAt.get(u) == epoch).size() <= 1

  val inv_paid_implies_owner: bool =             // P2
    Users.forall(u => (userPhase.get(u) == Done and purchasedAt.get(u) == epoch)
      implies (ticketStatus == Sold and ticketBuyer == u))

  val inv_view_consistent: bool =                // P3（本抽象層不可違反，見 §2.6.1）
    not(all { viewStatus == Available, ticketStatus == Sold })
}
```

### A.2 `checkoutFixed.qnt` 差異（修復方向，已驗證）

```quint
// confirm：+ 認領守衛
action confirm(u: str): bool = all {
  userPhase.get(u) == Paid,
  ticketBuyer == u,                              // 修復 F1/F3（含 Sold 冪等分支）
  ...
}
// gameOver：+ quiescence 守衛
action gameOver: bool = all {
  Users.forall(v => userPhase.get(v) != Paying and userPhase.get(v) != Paid),  // 修復 F2
  ...
}
```

## 附錄 B：重現命令（quint 0.32.0，需可寫 `$HOME`）

```bash
npm i @informalsystems/quint            # 或 -g；注意不是裸名 "quint"
quint typecheck checkout.qnt
# 模擬器（秒級，PR 閘門適用）
quint run checkout.qnt --main checkout --invariant=inv_no_double_sale      --max-steps=25 --seed=0x2a   # violation
quint run checkout.qnt --main checkout --invariant=inv_paid_implies_owner  --max-steps=25 --seed=0x2a   # violation（12 步反例見 §2.4）
quint run checkoutFixed.qnt --main checkoutFixed --invariant=inv_no_double_sale --max-steps=25 --seed=0x1   # ok
# Apalache 窮盡（需 Java 17+；depth 8 ≈ 5 分鐘）
quint verify checkout.qnt      --main checkout      --invariant=inv_no_double_sale --max-steps=10        # counterexample
quint verify checkoutFixed.qnt --main checkoutFixed --invariant=inv_no_double_sale,inv_paid_implies_owner --max-steps=8  # no violation
```
