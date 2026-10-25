/**
 * 预加载桥：把"窗口控制"能力暴露给界面（contextIsolation 下唯一的安全通道）。
 * 只暴露必要的最小接口，渲染进程拿不到 Node。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aw', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  getBounds: () => ipcRenderer.invoke('win:get-bounds'),
  setBounds: (bounds) => ipcRenderer.send('win:set-bounds', bounds),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximizeChange: (handler) => ipcRenderer.on('win:maximized', (_event, value) => handler(value)),
  /** 在资源管理器里打开某个文件夹（工作区 / 卡片 / 板块 / 会话） */
  openPath: (target) => ipcRenderer.invoke('app:open-path', target),
  /** 用系统默认浏览器打开 API Key 创建页（主进程有白名单校验） */
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  /** 应用内更新：检查 → 下载 → 应用并重启 */
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    apply: () => ipcRenderer.invoke('update:apply'),
    onProgress: (handler) => ipcRenderer.on('update:progress', (_event, percent) => handler(percent)),
    onAvailable: (handler) => ipcRenderer.on('update:available', (_event, info) => handler(info)),
    onShowNotes: (handler) => ipcRenderer.on('update:show-notes', () => handler()),
    onCheckFailed: (handler) => ipcRenderer.on('update:check-failed', (_event, info) => handler(info)),
  },
})