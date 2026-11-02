// 检查 SSE 是否真的把数据推出来了（隧道上最容易踩的坑）
// 用法：node tools/sse-check.mjs https://你的地址
const base = (process.argv[2] || "http://localhost:8787").replace(/\/+$/, "");
const room = process.argv[3] || "";

const url = room ? `${base}/api/rooms/${room}/events` : `${base}/api/rooms/demo/events`;
console.log(`连接 ${url}`);

const started = Date.now();
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 12000);

try {
  const res = await fetch(url, { signal: ctrl.signal });
  console.log(`HTTP ${res.status} ${res.headers.get("content-type")}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    const text = dec.decode(value, { stream: true });
    console.log(`+${Date.now() - started}ms 收到 ${value.length} 字节：${text.slice(0, 120).replace(/\n/g, "\\n")}`);
    if (got > 200) break;
  }
  console.log(got > 0 ? "✅ SSE 正常，数据能出来" : "❌ 连上了但没有任何数据（被缓冲了）");
} catch (err) {
  console.log(`❌ ${Date.now() - started}ms 失败：${err.name} ${err.message}`);
} finally {
  clearTimeout(timer);
  process.exit(0);
}
