import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("重命名原地编辑，分类加号原处展开，按钮尺寸和拖动把手统一", async () => {
  const app = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../../public/style.css", import.meta.url), "utf8");
  assert.match(app, /class="input rename-input"/);
  assert.doesNotMatch(app, /class="rename-editor"/);
  assert.match(app, /icon\(editing \? "check" : "pencil"\)/);
  assert.match(app, /class="folder-create \$\{S\.creatingFolder/);
  assert.match(app, /class="folder-input"/);
  assert.match(app, /data-act="sort-handle"/);
  assert.match(app, /pointerdown.*sort-handle/s);
  assert.match(app, /movePlaylistTrack\(/);
  assert.match(css, /\.icon-btn svg\s*\{\s*width: 14px; height: 14px/);
  assert.doesNotMatch(css, /\.rename-btn\s*\{[^}]*font-size: 19px/);
  assert.match(css, /\.folder-create\.expanded\s*\{/);
  assert.match(css, /\.sort-handle\s*\{/);
});

test("歌单不因短暂缓冲和缓存巡检反复插入消息并重建", async () => {
  const app = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /正在逐首核对本机的音频原文件…/);
  assert.doesNotMatch(app, /S\.status\.buffering\s*&&\s*S\.now\.playback\.playing/);
  assert.match(app, /audioHealth:\s*S\.audioHealth\s*\?\s*JSON\.stringify\(\{\s*\.\.\.S\.audioHealth,\s*checking:\s*false/);
});
