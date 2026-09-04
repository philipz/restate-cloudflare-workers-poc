// 經 `node --import ./test/loader/register.mjs` 載入：
// 註冊自訂 ESM resolve hooks（見 loader-hooks.mjs），
// 之後 `node --test dist/test/` 載入的模組皆套用。
import { register } from "node:module";

register("./loader-hooks.mjs", import.meta.url);
