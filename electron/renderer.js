/**
 * Electron 窗口渲染层。
 * 所有系统能力都通过 preload 暴露的 window.gugu 调用。
 */
const $ = (id) => document.getElementById(id);

const phaseLabel = {
  idle: "等待启动",
  restarting: "正在重新启动",
  "starting-server": "正在启动本地服务",
  "starting-tunnel": "正在连接 Cloudflare",
  "waiting-tunnel": "仍在等待公网地址",
  ready: "服务已就绪",
  error: "启动遇到问题",
};

function paint(state) {
  $("status").textContent = phaseLabel[state.phase] || state.phase;
  $("message").textContent = state.message || "";
  $("url").value = state.installUrl || "";
  $("copy").disabled = !state.installUrl;
  $("local").textContent = state.localBase ? `本地：${state.localBase}` : "";
  $("logs").textContent = state.logs?.length ? state.logs.join("\n") : "等待日志…";

  const dot = $("dot");
  dot.className = "dot";
  if (state.phase === "ready") dot.classList.add("ok");
  else if (state.phase === "error") dot.classList.add("bad");
  else dot.classList.add("busy");
}

$("copy").addEventListener("click", async () => {
  if (await window.gugu.copyInstallUrl()) {
    const old = $("copy").textContent;
    $("copy").textContent = "已复制";
    setTimeout(() => ($("copy").textContent = old), 1200);
  }
});

$("restart").addEventListener("click", async () => {
  $("restart").disabled = true;
  try {
    paint(await window.gugu.restart());
  } finally {
    $("restart").disabled = false;
  }
});

$("owlbear").addEventListener("click", () => window.gugu.openOwlbear());

window.gugu.onState(paint);
paint(await window.gugu.getState());
