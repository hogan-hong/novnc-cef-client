# Windows 本地构建指南

## 前置要求

1. **Node.js 20.x LTS** — https://nodejs.org/
2. **Git** — https://git-scm.com/downloads

## 构建步骤

### 1. 克隆并安装依赖
```bash
git clone https://github.com/hogan-hong/novnc-cef-client.git
cd novnc-cef-client
npm install
```

### 2. 直接运行（开发调试）
```bash
npm start
```

### 3. 打包成可执行文件
```bash
npm run build:win
```

打包完成后在 `dist` 目录下生成可执行文件。

## 配置文件

将 `配置文件.int` 放在exe同目录下。支持 UTF-8 和 GBK 编码自动检测。

## 常见问题

### 运行时白屏
检查配置文件中URL是否正确，VNC服务是否正常运行。

### 窗口无法连接VNC
确认目标机器的VNC服务和websockify已启动，端口可访问。

### 日志位置
日志写入exe同目录下的 `Log.txt`。
