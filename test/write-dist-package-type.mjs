// tsc 輸出到 dist/ 的模組是 ESM，但 repo 根 package.json 沒有 "type" 欄位
// （且不應為了測試動到部署設定）——在 dist/ 內放一個 package.json 標明
// type: module，讓 Node 直接以 ESM 載入編譯产物。
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("../dist/package.json", import.meta.url), JSON.stringify({ type: "module" }) + "\n");
