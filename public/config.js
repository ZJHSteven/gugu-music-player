// 部署配置。
//
// 两种用法：
//   A. 扩展和后端由同一个服务提供（默认，什么都不用改）
//      → window.BARD_API = ""
//   B. 扩展放在 GitHub Pages（或任何静态托管），后端在别处
//      → 填后端地址，例如 "https://music.example.com"
//
// 也可以用链接参数临时覆盖：manifest 里的 popover 追加 ?api=https://...
window.BARD_API = "";
