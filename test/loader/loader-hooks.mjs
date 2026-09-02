// Node ESM loader hooks（module.register 自訂化 hooks）：
// 1. 把所有 `@restatedev/restate-sdk*` 匯入導向 ./fake-restate-sdk.mjs
//    （實際 SDK 在純 Node 下因 wasm default-import 無法載入，見該檔註解）。
// 2. 對 tsc 輸出的無副檔名相對 import（如 "./game"）補上 ".js"，
//    讓 src 現有 import 寫法（moduleResolution: bundler）能在 Node 原生 ESM 下執行，
//    而不需要修改任何 src/ 原始碼或新增打包套件。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FAKE_SDK = new URL("./fake-restate-sdk.mjs", import.meta.url).href;
const SDK_PREFIX = "@restatedev/";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(SDK_PREFIX)) {
    return { url: FAKE_SDK, format: "module", shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context &&
      context.parentURL
    ) {
      const candidate = new URL(specifier + ".js", context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module", shortCircuit: true };
      }
    }
    throw err;
  }
}
