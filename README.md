# Clipboard Sync 剪贴板同步工具

一个基于Electron的跨平台剪贴板同步工具，支持在Mac和Windows之间实时同步文本和图片。

## 功能特性

- 支持Mac和Windows系统之间的剪贴板同步
- 自动发现局域网内的设备
- 支持文本和图片的实时同步
- 系统托盘运行，占用资源少
- 断线自动重连
- 简洁的用户界面

## 系统要求

- Windows 10及以上版本
- macOS 10.12及以上版本
- 设备必须在同一局域网内

## 安装说明

1. 确保你的系统已安装Node.js (推荐v16及以上版本)
2. 克隆项目到本地：
   ```bash
   git clone [项目地址]
   cd clipboard-sync
   ```
3. 安装依赖：
   ```bash
   npm install
   ```
4. 运行应用：
   ```bash
   npm start
   ```

## 使用方法

1. 在Mac电脑上启动应用，它将自动作为服务器运行
2. 在Windows电脑上启动应用，它将自动搜索并连接到Mac服务器
3. 连接成功后，状态栏会显示"已连接"
4. 此时在任一设备上复制的文本或图片都会自动同步到另一台设备

## 注意事项

- 确保两台设备在同一局域网内
- 如果连接断开，可以通过托盘菜单中的"重新连接"选项手动重连
- 应用会自动最小化到系统托盘运行
- 可以通过托盘图标右键菜单进行操作

## 技术栈

- Electron
- WebSocket
- Node.js
- UDP广播（用于设备发现）

## 开发构建

构建Windows版本：
```bash
npm run build --win
```

构建Mac版本：
```bash
npm run build --mac
```

## 许可证

ISC License

## 问题反馈

如果你在使用过程中遇到任何问题，欢迎提交Issue。 