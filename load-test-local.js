// 本地版負載測試：邏輯已與雲端版合併到 load-test.js（單一事實來源），
// 本檔僅保留為相容入口，預設 TARGET=local（http://localhost:8080、免驗證）。
//
//   k6 run load-test-local.js
//   k6 run -e VUS=10 -e DURATION=60s load-test-local.js
//
// 等價於：k6 run -e TARGET=local load-test.js
//
// 為什麼保留：README 與既有操作習慣皆引用此檔名；直接刪除會破壞既有指令。
export { options, setup, teardown, default } from './load-test.js';
