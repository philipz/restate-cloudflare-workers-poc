// 可注入的延遲（模擬外部 I/O latency）。
//
// 為什麼需要：payment/email 以 `setTimeout` 模擬 500ms／200ms 外部延遲。
// 這在正式環境是刻意行為，但在單元測試中會讓每個相關案例真的睡滿——
// 測試套件的 wall time 幾乎全是 sleep（且與被測邏輯無關）。
//
// 設計（零新增相依，符合停手規則 SR5）：
// - 正式環境：行為與原本完全一致（`await new Promise(r => setTimeout(r, ms))`）。
// - 測試環境：呼叫 `setDelayImpl(() => Promise.resolve())` 即可讓延遲歸零；
//   `resetDelayImpl()` 還原。不讀環境變數（Workers 執行期無 process.env），
//   改用顯式注入，避免正式路徑出現任何測試專用分支。

export type DelayFn = (ms: number) => Promise<void>;

const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let impl: DelayFn = realDelay;

/** 等待 ms 毫秒（可被 setDelayImpl 覆寫）。 */
export function delay(ms: number): Promise<void> {
    return impl(ms);
}

/** 注入延遲實作（測試用；傳入 () => Promise.resolve() 可讓延遲歸零）。 */
export function setDelayImpl(fn: DelayFn): void {
    impl = fn;
}

/** 還原為真實計時器實作。 */
export function resetDelayImpl(): void {
    impl = realDelay;
}
