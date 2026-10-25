# HDream

本地 Agent 工作台（Electron + 零依赖 Node 服务 + 原生前端）。

- `electron/` Electron 主进程、预加载、更新器
- `public/` 渲染层（原生 JS/CSS）
- `server.mjs` / `workspace.mjs` / `plugins.mjs` 本地服务、工作区文件系统、插件市场
- `tools/` 发布与打包脚本

## 打包安装程序

云端：Actions → build-installer → Run workflow（产物在 Actions artifacts 里，不会自动发 Release）
本地：`npx electron-builder --win nsis --publish never`
