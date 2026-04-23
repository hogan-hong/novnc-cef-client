# NoVNC CEF客户端
基于Electron（底层采用CEF/Chromium开源浏览器架构）开发的NoVNC客户端，启动自动连接指定的远程桌面。

## 特性
✅ 无标题无边框窗口，仅显示NoVNC远程桌面画面
✅ 全GPU硬件加速渲染，画面流畅低延迟
✅ 启动自动加载指定NoVNC地址，无需手动输入
✅ 可打包成单文件便携版，无需安装直接运行

## 使用方法
### 直接运行
```bash
npm start
```
启动后会自动打开853x480分辨率的窗口，加载`http://neiwang.hogan.ltd/novnc/iPhone_853x480_run.html?token=01&IP=172.16.103.201`地址。

### 打包成可执行文件
#### Windows便携版
```bash
npm run build:win
```
打包完成后在`dist`目录下生成`NoVNC Client x.x.x.exe`，双击直接运行，不需要安装任何依赖。

#### Linux AppImage
```bash
npm run build:linux
```

#### macOS
```bash
npm run build:mac
```

## 配置修改
如果需要修改NoVNC地址或者窗口大小，编辑`index.js`文件：
- 修改`loadURL`参数更换连接地址
- 修改`width/height`参数调整窗口分辨率
