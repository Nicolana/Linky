# Linky - 局域网文件共享工具

Linky 是一个简单高效的局域网文件共享桌面应用，基于 Electron 开发，支持 Windows、MacOS 和 Linux 平台。它提供了直观的界面和强大的功能，让局域网内的文件共享变得简单快捷。

## 功能特点

### 设备发现
- 自动扫描局域网内在线设备
- 实时显示设备状态（在线/离线）
- 显示设备名称和 IP 地址
- 支持设备状态自动更新

### 文件共享
- 支持选择共享目录
- 文件拖拽上传
- 文件列表实时更新
- 支持文件搜索
- 显示文件大小和修改时间
- 支持文件和文件夹的区分显示

### 文件传输
- 点对点高速传输
- 支持断点续传
- 实时显示传输进度
- 显示传输速度
- 支持取消传输
- 传输历史记录

### 安全性
- 基于本地网络，无需互联网连接
- 文件传输加密
- 设备身份验证
- 传输状态监控

## 安装说明

### 开发环境安装
1. 确保已安装 Node.js (推荐 v16 或更高版本)
2. 克隆项目并安装依赖：
```bash
git clone https://github.com/yourusername/linky.git
cd linky
npm install
```

### 运行开发版本
```bash
npm start
```

### 打包应用
```bash
# 打包 Windows 版本
npm run build:win

# 打包 MacOS 版本
npm run build:mac

# 打包 Linux 版本
npm run build:linux

# 打包所有平台
npm run build:all
```

打包后的文件将位于 `dist` 目录中。

## 使用说明

1. 启动应用
2. 选择要共享的文件夹
3. 等待设备发现
4. 开始文件共享

### 文件共享
- 点击"选择共享目录"按钮选择要共享的文件夹
- 文件列表支持按名称搜索
- 显示文件大小和修改时间
- 支持文件和文件夹的区分显示

### 文件传输
- 点击文件右侧的"分享"按钮开始传输
- 传输进度实时显示
- 可以取消正在进行的传输
- 底部状态栏显示当前网速和传输任务数

## 系统要求

- Windows 10/11
- MacOS 10.13 或更高版本
- Linux (Ubuntu 18.04 或更高版本)
- 最小内存要求：4GB
- 推荐内存：8GB 或更高

## 技术栈

- Electron
- Node.js
- Express
- SQLite3
- HTML5/CSS3/JavaScript

## 贡献指南

欢迎提交 Issue 和 Pull Request 来帮助改进 Linky。

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 联系方式

- 项目主页：[GitHub](https://github.com/yourusername/linky)
- 问题反馈：[Issues](https://github.com/yourusername/linky/issues)

## 致谢

感谢所有为这个项目做出贡献的开发者们！ 