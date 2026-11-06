/**
 * preload 只暴露最小 API。
 * renderer 没有 Node 权限，也不能直接执行任意系统命令。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gugu", {
  getState: () => ipcRenderer.invoke("runtime:get"),
  copyInstallUrl: () => ipcRenderer.invoke("runtime:copy"),
  restart: () => ipcRenderer.invoke("runtime:restart"),
  openOwlbear: () => ipcRenderer.invoke("runtime:open-owlbear"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("runtime:state", listener);
    return () => ipcRenderer.removeListener("runtime:state", listener);
  },
});
