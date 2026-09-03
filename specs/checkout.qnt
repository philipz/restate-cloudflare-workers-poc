// checkout.qnt — Checkout×Ticket×SeatMap×GameManager 併發模型（BUGGY 語意）
// 來源：docs/research/11-quint-feasibility.md 附錄 A.1（Issue #11），逐字保留。
// 忠實反映現行 src/game.ts / src/checkout.ts / src/game_manager.ts 語意：
//   RC1 release 無條件覆蓋、RC2 confirm 無 caller 身分、RC3 fire-and-forget 重置。
// 預期驗證結果：P1/P2 不變量「必須」找到反例（紅燈＝設計要求，見 specs/README.md）。
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
