// checkoutFixed.qnt — 修復方向模型（已於研究報告驗證）
// 來源：docs/research/11-quint-feasibility.md 附錄 A.1＋A.2 差異（Issue #11）。
// 相對 checkout.qnt（BUGGY）僅兩處守衛差異（其餘逐字相同）：
//   1. confirm + 認領守衛 ticketBuyer == u（修復 F1/F3：RC2，含 Sold 冪等分支）
//   2. gameOver + quiescence 守衛（修復 F2：RC3，無 Paying/Paid in-flight 才重置）
// 預期驗證結果：P1/P2/P3 於固定 seed 之 quint run 均無反例（綠燈）。
module checkoutFixed {
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

  // checkout.ts:38-40 → game.ts:46-66；修復（A.2）：+認領守衛，Sold 冪等分支亦須 reservedBy==u
  action confirm(u: str): bool = all {
    userPhase.get(u) == Paid,
    ticketBuyer == u,                              // 修復 F1/F3：confirm 認領呼叫者
    userPhase' = userPhase.put(u, Done),
    purchasedAt' = purchasedAt.put(u, epoch),
    viewStatus' = Sold,                         // checkout.ts:40
    transientRetries' = transientRetries, epoch' = epoch,
    any {
      all { ticketStatus == Sold, ticketStatus' = Sold, ticketBuyer' = ticketBuyer },
      all { ticketStatus != Sold, ticketStatus' = Sold, ticketBuyer' = u },
    },
  }

  // game.ts:112-125 → game_manager.ts:11-17；修復（A.2）：+quiescence 守衛（串行化重置）
  action gameOver: bool = all {
    Users.forall(v => userPhase.get(v) != Paying and userPhase.get(v) != Paid),  // 修復 F2：有 in-flight saga 不重置
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
