// node:test 的最小環境型別宣告。
// 為什麼自己宣告：repo 沒有 @types/node 相依，而停手規則 SR5 禁止新增
// 相依清單外的套件——用零相依的 `node --test` 執行 + 本檔案補型別，
// 即可在不新增任何 npm 套件的前提下取得型別檢查。
// 只宣告測試實際用到的表面（對應 Node 22 node:test 運行時 API）。
declare module "node:test" {
  interface Assert {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(block: () => unknown, error?: RegExp | ((err: Error) => boolean), message?: string): void;
    rejects(
      block: (() => Promise<unknown> | Promise<unknown>) | Promise<unknown>,
      error?: RegExp | ((err: Error) => boolean),
      message?: string
    ): Promise<void>;
    fail(message?: string): never;
  }
  interface TestContext {
    assert: Assert;
  }
  type TestFn = (t: TestContext) => void | Promise<void>;
  interface TestOptions {
    skip?: boolean | string;
    only?: boolean;
    todo?: boolean | string;
    timeout?: number;
  }
  function test(name: string, fn?: TestFn): void;
  function test(name: string, options: TestOptions, fn?: TestFn): void;
  function describe(name: string, fn: () => void): void;
  function beforeEach(fn: () => void | Promise<void>): void;
  function afterEach(fn: () => void | Promise<void>): void;
  function it(name: string, fn?: TestFn): void;
  function it(name: string, options: TestOptions, fn?: TestFn): void;
  namespace it {
    function skip(name: string, fn?: TestFn): void;
    function only(name: string, fn?: TestFn): void;
  }
  namespace describe {
    function skip(name: string, fn?: () => void): void;
  }
}
