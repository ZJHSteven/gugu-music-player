import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateDirectUrl, filenameOf, responseToAudioFile } from "../../public/cloud/remote-import.js";
import { createState, addTrack } from "../../public/cloud/state.js";

test("音频直链只接受无凭据公网 HTTPS URL", () => {
  assert.equal(validateDirectUrl("https://example.org/music.mp3"), "https://example.org/music.mp3");
  for (const u of ["http://example.org/x.mp3", "https://localhost/x.mp3",
    "https://127.0.0.1/x.mp3", "https://[::1]/x.mp3",
    "https://abc:password@example.org/x.mp3", "file:///C:/x.wav"]) {
    assert.throws(() => validateDirectUrl(u), u);
  }
});
test("直链的文件名和 MIME 类型不把授权参数写入歌单", () => {
  assert.deepEqual(filenameOf("https://example.org/track.mp3?token=secret", "乐曲"), {
    name: "乐曲.mp3", mime: "audio/mpeg",
  });
  assert.equal(filenameOf("https://example.org/audio", "配乐", "audio/mp4").mime, "audio/mp4");
  assert.match(filenameOf("https://example.org/a.mp3", "../危险/名字").name, /\.mp3$/);
});
test("浏览器获取完整音频，File 的字节、名称与 MIME 不变", async () => {
  const data=Uint8Array.from([73,68,51,1,2,3,4,5,6,7]);
  const res = new Response(data, { headers: { "Content-Type": "audio/mpeg", "Content-Length": ""+data.length } });
  let progress=0;
  const file=await responseToAudioFile(res,{
    url:"https://example.org/audio.mp3",title:"bg",onProgress:p => { progress=p; },
  });
  assert.equal(file.name, "bg.mp3");
  assert.equal(file.type, "audio/mpeg");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()),data);
  assert.ok(progress>0.9);
});
test("网页响应、过大音频、空结果与HTTP错误均不入库",async()=>{
  await assert.rejects(()=>responseToAudioFile(new Response("<html>",{headers:{"Content-Type":"text/html"}}),
    {url:"https://x.org/x.mp3"}),/网页/);
  await assert.rejects(()=>responseToAudioFile(new Response("a",{headers:{
      "Content-Length":""+(64*1024*1024+1),"Content-Type":"audio/mpeg"}}),
    {url:"https://x.org/x.mp3"}),/64MiB/);
  await assert.rejects(()=>responseToAudioFile(new Response(null),{url:"https://x.org/x.mp3"}),/内容/);
  await assert.rejects(()=>responseToAudioFile(new Response("404",{status:404}),{url:"https://x.org/x.mp3"}),/404/);
});
test("错误页面即使伪装成音频 MIME 或 mp3 扩展名，也不能假成功", async () => {
  const fake = new Response("<!DOCTYPE html><title>Access denied</title>", {
    headers: { "Content-Type": "audio/mpeg" },
  });
  await assert.rejects(() => responseToAudioFile(fake, {
    url: "https://example.org/track.mp3", title: "假文件",
  }), /文件头不是支持的音频/);
});
test("真实内容是 MP4 时应覆盖错误的 .mp3 扩展名及 MIME", async () => {
  const mp4 = Uint8Array.from([0,0,0,24,102,116,121,112,77,52,65,32,0,0,0,0,0,0,0,0,0,0,0,0]);
  const file = await responseToAudioFile(new Response(mp4, {
    headers: { "Content-Type": "audio/mpeg" },
  }), { url: "https://example.org/misnamed.mp3", title: "混合容器" });
  assert.equal(file.type, "audio/mp4");
  assert.equal(file.name, "混合容器.m4a");
});
test("直链在共享歌单中只留下内容哈希，不留下可能敏感的来源URL",()=>{
  let state=createState("1".repeat(32));
  state=addTrack(state,{kind:"url",title:"配乐",hash:"b".repeat(64),size:456,
    mime:"audio/mpeg",srcUrl:"https://example.org/audio.mp3?token=private",folder:""});
  assert.equal(state.playlist[0].kind,"url");
  assert.equal(state.playlist[0].title,"配乐");
  assert.ok(!JSON.stringify(state).includes("private"));
});
test("BV号/视频链接入口保留，但点击只提示暂不支持，不触发任何请求",async()=>{
  const app=await readFile(new URL("../../public/app.js",import.meta.url),"utf8");
  const start=app.indexOf("function addBilibili() {");
  const end=app.indexOf("\nasync function addDirectAudio()",start);
  assert.ok(start>=0&&end>start);
  const body=app.slice(start,end);
  assert.match(body,/暂不支持/);
  assert.match(app,/id="bili"/);
  assert.match(app,/data-act="add-bili"/);
  // 保留原版 Node 兼容路径，但云版分支先 toast + return，不会调用它。
  const cloudPart=body.split('if (window.BARD_CLOUD) {')[1]?.split('if (S.busy)')[0];
  assert.ok(cloudPart);
  assert.match(cloudPart,/toast\(/);
  assert.match(cloudPart,/return;/);
  assert.doesNotMatch(cloudPart,/fetch\s*\(|apiPost\s*\(|uploadTrack\s*\(|setInterval\s*\(/);
  assert.doesNotMatch(app,/\/api\/bilibili\/(?:resolve|audio)/);
});
test("生产 Worker 仅处理 DO 按需路径；无 B站抓取路由、外呼、常驻定时器",async()=>{
  const worker=await readFile(new URL("../../cloud-worker/index.js",import.meta.url),"utf8");
  const wrangler=JSON.parse(await readFile(new URL("../../wrangler.jsonc",import.meta.url),"utf8"));
  assert.doesNotMatch(worker,/handleBiliGateway|api\.bilibili|\/api\/bilibili\//);
  assert.doesNotMatch(worker,/setInterval\s*\(|setTimeout\s*\(|setAlarm\s*\(|fetch\s*\(\s*["']https:/);
  assert.match(worker,/this\.ctx\.acceptWebSocket\(server\)/);
  assert.match(worker,/serializeAttachment/);
  assert.deepEqual(wrangler.assets.run_worker_first,["/relay"]);
});
test("诊断只在设置页按需展示，歌单页不再附带日志区",async()=>{
  const app=await readFile(new URL("../../public/app.js",import.meta.url),"utf8");
  assert.match(app,/settingsView\(\) \+ diagnosticsView\(\)/);
  assert.match(app,/function playerSettingsView\(\)/);
  assert.doesNotMatch(app,/\(S\.role === "GM" \? gmView\(\) : playerView\(\)\) \+ diagnosticsView\(\)/);
});

