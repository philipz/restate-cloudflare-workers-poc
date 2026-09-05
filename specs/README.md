# specs/ — Checkout 併發競態的 Quint 驗證模型（Issue #14）

依 [docs/research/11-quint-feasibility.md](../docs/research/11-quint-feasibility.md)（Issue #11 可行性報告）
**方案 B** 落地：把 POC 的 `Checkout × Ticket × SeatMap × GameManager` 核心併發流程建模為 Quint 規格，
以機械可重現的方式固定 F1（同回合雙重成交）、F2（已付款者失去票）兩個競態缺陷，並驗證修復方向。

> 本目錄為**驗證資產**（test-only）：`src/**`、`test/**`、`package.json`、`.github/**` 均未觸碰。
> 未新增任何 repo 相依——quint 一律以 `npx --yes` 一次性執行（Issue #14 明示授權，停手規則 SR5 不受觸發）。

## 檔案

| 檔案 | 內容 | 來源 |
|---|---|---|
| `checkout.qnt` | **現行正式規格（修復版）**：忠實反映修復後之程式碼邏輯（`confirm` 認領守衛 `ticketBuyer == u`、`gameOver` quiescence 靜止期守衛；Issue #21 起 `reserve` 對已 `Reserved` 一律拒絕含同一使用者） | 附錄 A.1＋A.2 |
| `checkoutBuggy.qnt` | **歷史缺陷對照模型（BUGGY 基準）**：忠實保留修復前程式碼缺陷語意（RC1 `release` 無條件覆蓋、RC2 `confirm` 無 caller 身分、RC3 fire-and-forget 重置） | 附錄 A.1 逐字 |
| `README.md` | 本檔：執行入口與實測記錄 | — |

模型範圍：**7 個狀態變數**（ticketStatus、ticketBuyer、viewStatus、userPhase、transientRetries、epoch、purchasedAt）、
**6 個 action**（reserve、payTransient、payTerminal、paySuccess、confirm、gameOver）、
**3 條不變量**：P1 `inv_no_double_sale`（同回合 ≤1 個 Done）、P2 `inv_paid_implies_owner`（成交者仍持有票）、
P3 `inv_view_consistent`（視圖 AVAILABLE ⇒ 真值非 SOLD）。

## 語意約定

- `checkout.qnt` 為**現行程式碼之正式規格**：固定 seed 下**不得**出現反例（exit 0／`No violation found`），為 CI PR 閘門驗證對象。
- `checkoutBuggy.qnt` 是對**修復前歷史實作**的缺陷對照模型：quint 找到反例（exit 1／`Invariant violated`）為設計要求——證明模型能重現 37 個綠燈單元測試放過的競態。

## 執行入口（需網路＋可寫 `$HOME`，首次執行下載 rust evaluator）

```bash
Q="npx --yes @informalsystems/quint@0.32.0"
cd specs

# 1) 型別檢查（兩者皆應 exit 0）
$Q typecheck checkout.qnt
$Q typecheck checkoutBuggy.qnt

# 2) 現行正式規格（checkout.qnt）：三條不變量 × 4 seeds 均應無反例（exit 0）
for s in 0x1 0x2 0x3 0x4; do
  for i in inv_no_double_sale inv_paid_implies_owner inv_view_consistent; do
    $Q run checkout.qnt --main checkout --invariant=$i --max-steps=25 --seed=$s --max-samples=1000
  done
done

# 3) 歷史缺陷對照（checkoutBuggy.qnt）：P1/P2 必須找到反例（exit 1＝紅燈＝重現缺陷）
$Q run checkoutBuggy.qnt --main checkoutBuggy --invariant=inv_no_double_sale     --max-steps=25 --seed=0x2a
$Q run checkoutBuggy.qnt --main checkoutBuggy --invariant=inv_paid_implies_owner --max-steps=25 --seed=0x2a
$Q run checkoutBuggy.qnt --main checkoutBuggy --invariant=inv_no_double_sale     --max-steps=25 --seed=0x77 --max-samples=20000
```

注意（quint 0.32.0 實測）：`--seed` 給定時 `--max-samples` 預設為 **1**（單軌確定性重現）；
`quint run --invariant` 不接受逗號多不變量，需逐個執行。

## 實測記錄（本沙箱：Node v22.21.1、`@informalsystems/quint` 0.32.0、rust evaluator）

| 命令（縮寫） | 宣稱（報告 §2.4／附錄 B） | 實測 |
|---|---|---|
| typecheck checkout／checkoutBuggy | 0.32.0 通過 | ✅ exit 0 ×2 |
| Canonical P1/P2 @0x1–0x4（max-samples=1000） | 無反例 | ✅ 8/8 `[ok] No violation found`（~2300 traces/s） |
| Canonical P3 @0x1–0x4 | 無反例 | ✅ 4/4 `[ok] No violation found` |
| BUGGY P1 @0x2a | violation | ✅ `Invariant violated`，11 步反例（末態 `epoch=4`，`userPhase: A→Done, B→Done`，`purchasedAt: A→4, B→4`——同回合雙成交） |
| BUGGY P2 @0x2a | violation | ✅ `Invariant violated`（末態 `ticketBuyer:"B"` 而 `userPhase: A→Done`——已付款者不持有票） |
| BUGGY P3 @0x2a | 不可違反（§2.6.1） | ✅ 無反例（與宣稱一致：本抽象層 `set` 與真值同步） |
| BUGGY P1 @0x77 | violation | ⚠️ 單軌（預設 max-samples=1）**未**命中；`--max-samples=20000` 則 ✅ violation（命中軌道 0x8d7）。差異如實記錄：0x77 非單軌確定性反例 |

### BUGGY 反例末態（seed 0x2a，P1，對應報告 §2.4 S11）

```
[State 11] { epoch: 4, purchasedAt: Map("A" -> 4, "B" -> 4), ticketBuyer: "B",
  ticketStatus: Sold, transientRetries: 1, userPhase: Map("A" -> Done, "B" -> Done), viewStatus: Sold }
```

A 的保留被 gameOver 無條件釋放（RC1/RC3）、B 成交後 A 的 confirm 經 Sold 冪等分支仍回成功（RC2）→
同回合 A、B 雙 Done，違反 P1；A 不持有票，同時違反 P2。

## 未納入 DoD：Apalache 窮盡驗證（記錄備查，需 Java 17+）

```bash
$Q verify checkoutBuggy.qnt --main checkoutBuggy --invariant=inv_no_double_sale --max-steps=10        # 窮盡反例
$Q verify checkout.qnt      --main checkout      --invariant=inv_no_double_sale --max-steps=8         # no violation（約 5.2 分鐘）
```

本沙箱已具備 Java（`/usr/bin/java`），但依 Issue #14 之刻意設計，DoD 以固定 seed 的 `quint run` 為準；
CI 閘門屬 N5（人類執行，停手規則 3）。

## 建模限制（承接報告 §2.6，誠實記錄）

1. **P3 在此抽象層不可違反，但實作層可達（Issue #22 實例）**：模型把 SeatMap 寫入建模為與真值同步，
   故 `inv_view_consistent` 在此抽象下永遠成立；**實作並非如此**——`src/checkout.ts` 的補償路徑
   原本無條件 `seatMap.set(AVAILABLE)`，當票已被他人買走（`Ticket.release` 回 `false`）時，
   該寫入會覆蓋買家較新的 `SOLD`（last-writer-wins），造成**永久性幽靈可售票**，即 P3 的實作層反例。
   已於 Issue #22 修復（補償僅在 `release` 回 `true` 時才回寫視圖），並由
   `test/integration_scenarios.test.ts` 的 S2 情境（ctx.run hook 精準插隊）機械化守住。
   本項為「模型抽象落差」的警示：P3 在模型無反例**不等於**實作無此類缺陷；
   要在模型層涵蓋需訊息佇列/非同步視圖模型（N4 範圍）。
2. 50 張票→1 張代表票為對稱性抽象：對反例發現保守，不驗證「湊滿 50」觸發條件。
3. 未建模 restate-server 持久化/重播細節；驗證對象是應用層狀態機＋投遞順序。
4. P4（重試最終成功）為意圖性質，需 fairness 的時序驗證列於報告長期項，未在此實現。
