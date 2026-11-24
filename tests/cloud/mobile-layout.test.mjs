import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("触屏窄面板不再被历史 320px 高度和 150px 占位裁成半屏", async () => {
  const css = await readFile(new URL("../../public/style.css", import.meta.url), "utf8");
  const mobile = css.match(/@media\s*\(pointer:\s*coarse\)\s*and\s*\(max-width:\s*560px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(mobile, "应保留触屏手机专用的容器高度规则");
  assert.match(mobile, /\.app\s*\{\s*height:\s*100%;\s*max-height:\s*100%;\s*\}/);
  assert.doesNotMatch(mobile, /320px|150px|padding-bottom/);
  assert.match(css, /html,\s*body\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.main\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.main\s*\{[^}]*padding:[^}]*safe-area-inset-bottom/);
});
