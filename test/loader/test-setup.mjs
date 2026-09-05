// 測試全域設定：把 src/utils/delay 的模擬延遲歸零。
//
// 為什麼：payment（500ms）／email（200ms）／mock gateway（500ms）的 sleep 是
// 「模擬外部 I/O」的刻意行為，但在測試中純屬等待——本檔在測試啟動時注入
// 零延遲實作，使套件 wall time 反映真正的邏輯成本。
//
// 這不會削弱任何斷言：延遲長度本身從未被任何測試斷言，被驗證的是
// 回傳值／拋錯型別／狀態轉移／呼叫順序。需要驗證「時間」語意的測試
// （如 TTL 逾期）走的是 harness 的受控時鐘 world.now()，與此無關。
//
// 載入時機：由 package.json 的 test script 以 `--import` 在 loader 註冊之後引入，
// 因此這裡 import 的 dist 產物與測試看到的是同一份模組實例。
import { setDelayImpl } from "../../dist/src/utils/delay.js";

setDelayImpl(() => Promise.resolve());
