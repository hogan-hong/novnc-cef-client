# Windows本地构建指南

由于GitHub Actions在Windows环境构建存在技术问题，建议在本地Windows环境构建。

## 前置要求

1. **安装Node.js和npm**
   - 下载：https://nodejs.org/
   - 选择LTS版本（推荐18.x或20.x）
   - 安装后验证：
     ```bash
     node --version
     npm --version
     ```

2. **安装Git**
   - 下载：https://git-scm.com/downloads
   - 安装后验证：
     ```bash
     git --version
     ```

3. **安装Python和C++构建工具（编译native模块需要）**
   - 安装Python 3.x：https://www.python.org/downloads/
   - 安装Visual Studio Build Tools：https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - 或安装Visual Studio Community（选择"使用C++的桌面开发"工作负载）

## 构建步骤

### 方法1：快速构建（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/hogan-hong/novnc-cef-client.git
cd novnc-cef-client

# 2. 安装依赖
npm install

# 3. 构建应用（native模块可选）
npm run build:win

# 4. 查看生成的文件
dir dist\
```

### 方法2：分步构建（调试用）

```bash
# 1. 克隆项目
git clone https://github.com/hogan-hong/novnc-cef-client.git
cd novnc-cef-client

# 2. 安装依赖
npm install
# 或使用npm ci（更严格）
npm ci

# 3. 编译native模块（Windows）
npm run build:native
# 检查是否成功
dir build\Release\

# 4. 构建应用
npm run build:win

# 5. 查看构建产物
dir dist\
```

## 构建产物

构建成功后，在`dist`目录下会看到：

### NSIS安装器（默认）
```
dist/
└── NoVNC Client Setup 1.0.0.exe  # Windows安装器
```

### 其他可能的位置
```
dist/
└── win-unpacked/                  # 未打包的文件夹版本
    ├── NoVNC Client.exe          # 可执行文件
    ├── resources/                # 资源文件
    └── ...
```

## 运行应用

### 使用安装器
```bash
# 双击运行安装器
dist\NoVNC Client Setup 1.0.0.exe
```

### 直接运行（如果是win-unpacked目录）
```bash
# 直接运行exe
dist\win-unpacked\NoVNC Client.exe
```

## 验证构建

运行应用后，检查`Log.txt`文件：

```bash
# 查看窗口句柄输出
type Log.txt
```

应该看到类似输出：
```
窗口 1: 标题="iPhone Se2 D1" HWND=332340
窗口 2: 标题="iPhone Se2 D2" HWND=332341
...
```

## 编译问题修复

### 问题：添加native模块后编译失败

**原因**：native模块使用了Windows GDI函数，但缺少`gdi32.lib`链接库。

**修复内容**：
- 添加`gdi32.lib`链接库到binding.gyp
- 添加Windows编译器配置（禁用C++异常）

**验证方法**：
```bash
npm run build:native
# 应该看到：
# gyp info ok
# 或者没有错误
```

如果编译成功，会生成：
```
build/Release/osr_helper.node
```

### 如果native模块编译失败

可以跳过native模块，直接构建：

```bash
# 只构建JS部分，不编译native模块
npm install
npm run build:win
```

应用会继续运行，但OSR绘制功能会被跳过（日志会提示"[OSR] native模块不可用"）。

## 常见问题

### Q1: npm install失败
**原因**：网络问题或Node版本不兼容

**解决**：
```bash
# 使用国内镜像
npm config set registry https://registry.npmmirror.com
npm install
```

### Q2: native模块编译失败
**原因**：缺少C++构建工具

**解决**：
```bash
# 安装windows-build-tools
npm install --global windows-build-tools

# 或手动安装Visual Studio Build Tools
# https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

### Q3: electron-builder构建失败
**原因**：权限问题或磁盘空间不足

**解决**：
```bash
# 以管理员身份运行PowerShell/CMD
# 确保有足够的磁盘空间（至少2GB）

# 查看详细错误
npm run build:win -- --verbose
```

### Q4: 找不到dist目录
**原因**：构建失败

**解决**：
```bash
# 查看构建日志
npm run build:win

# 检查package.json配置
type package.json
```

## 调试技巧

### 查看详细构建日志
```bash
# electron-builder详细输出
npm run build:win -- --verbose

# 查看所有输出
npm run build:win -- --verbose --no-color
```

### 检查native模块
```bash
# 检查native模块是否编译成功
dir build\Release\osr_helper.node

# 测试native模块加载
node -e "require('./build/Release/osr_helper.node')"
```

### 查看electron-builder配置
```bash
# 列出所有打包的文件
npx electron-builder --list-files
```

## 打包配置说明

当前配置使用NSIS安装器，生成单个exe文件。

如果需要其他格式，可以修改`package.json`的`build.win.target`：

```json
"win": {
  "target": [
    "portable",   // 绿色版exe（免安装）
    "nsis",       // NSIS安装器
    "zip",        // 压缩包
    "7z"          // 7zip压缩包
  ]
}
```

## 优化建议

### 加快构建速度
```bash
# 使用--config.compression=store减少压缩时间
npm run build:win -- --config.compression=store
```

### 减小文件体积
```bash
# 使用asar打包（默认启用）
# 排除不必要的文件
npm run build:win -- --config.compression=maximum
```

## 联系支持

如果遇到其他问题：
1. 查看构建日志：`dist/builder-effective-config.yaml`
2. 检查electron-builder文档：https://www.electron.build/
3. 在GitHub提issue：https://github.com/hogan-hong/novnc-cef-client/issues

## 快速开始

一键构建脚本（Windows PowerShell）：

```powershell
# 创建build.ps1
@"
git clone https://github.com/hogan-hong/novnc-cef-client.git
cd novnc-cef-client
npm install
npm run build:win
Write-Host "构建完成！查看 dist 目录"
Start-Process ".\dist"
"@ | Out-File -Encoding utf8 build.ps1

# 运行
.\build.ps1
```