# NoVNC 群控客户端

基于Electron开发的NoVNC群控客户端，支持多窗口同时操作、主控窗口同步、HTTP API外部控制。

## 特性

✅ 无标题无边框窗口，仅显示NoVNC远程桌面画面
✅ 全GPU硬件加速渲染，画面流畅低延迟
✅ 启动自动加载指定NoVNC地址，无需手动输入
✅ 多窗口同步操作：主控窗口输入自动同步到其他窗口
✅ 主控窗口切换：点击窗口内"主控"按钮切换主控源
✅ HTTP API外部控制：支持通过API发送点击、滑动、键盘等指令
✅ 可打包成单文件便携版，无需安装直接运行

## 使用方法

### 配置文件

将 `配置文件.int` 放在exe同目录下，格式示例：

```ini
组1名称=测试组
URL1=http://neiwang.hogan.ltd/novnc/iPhone_853x480_run.html?token=01&IP=172.16.103.201
窗口标题1=手机1
控制IP1=172.16.103.201
URL2=http://neiwang.hogan.ltd/novnc/iPhone_853x480_run.html?token=02&IP=172.16.103.202
窗口标题2=手机2
控制IP2=172.16.103.202
...
```

- 每组最多5个窗口，最多10组（共50个窗口）
- 编码支持 UTF-8 和 GBK 自动检测

### 直接运行

```bash
npm start
```

### 打包成可执行文件

#### Windows便携版
```bash
npm run build:win
```
打包完成后在 `dist` 目录下生成 `NoVNC Client x.x.x.exe`，双击直接运行。

#### Linux AppImage
```bash
npm run build:linux
```

#### macOS
```bash
npm run build:mac
```

## 同步操作

### 开启同步

点击右下角"同步"按钮开启同步模式。开启后：

- 主控窗口（默认窗口0）的鼠标、键盘、滚轮操作会同步到其他窗口
- 每个窗口右下角出现"主控"按钮，点击可切换主控窗口
- 主控窗口按钮显示绿色"主控✓"，非主控窗口显示灰色"主控"

### 关闭同步

再次点击右下角按钮（此时显示"关闭同步"）即可关闭。

## HTTP API

启动后自动开启HTTP API服务，端口为 `38980 + 组号`（如第1组端口38981，第2组端口38982）。

### 坐标系统

API坐标基于客户端横屏分辨率 **856×480**，超出此范围的坐标将被忽略。内部自动转换为手机实际分辨率 **1334×750**。

### 控制命令

**POST** 请求，JSON格式：

```json
{
  "action": "click",
  "x": 428,
  "y": 240,
  "windowIndex": 0
}
```

#### 支持的 action

| action | 说明 | 参数 |
|--------|------|------|
| `click` | 左键单击 | x, y, windowIndex |
| `clickAll` | 左键单击所有窗口 | x, y |
| `rightclick` | 右键单击 | x, y, windowIndex |
| `rightclickAll` | 右键单击所有窗口 | x, y |
| `drag` | 左键拖动 | fromX, fromY, toX, toY, duration, mode, hold, windowIndex |
| `dragAll` | 左键拖动所有窗口 | fromX, fromY, toX, toY, duration, mode, hold |
| `scroll` | 滚轮 | x, y, deltaX, deltaY, windowIndex |
| `scrollAll` | 滚轮所有窗口 | x, y, deltaX, deltaY |
| `keypress` | 按键 | code, down, windowIndex |
| `keypressAll` | 按键所有窗口 | code, down |
| `clipboard` | 粘贴文本 | text, windowIndex |
| `clipboardAll` | 粘贴文本所有窗口 | text |

#### drag 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `fromX` | int | 是 | - | 按下坐标X |
| `fromY` | int | 是 | - | 按下坐标Y |
| `toX` | int | 是 | - | 抬起坐标X |
| `toY` | int | 是 | - | 抬起坐标Y |
| `duration` | int | 否 | 300 | 拖动时间（毫秒） |
| `mode` | string | 否 | `uniform` | 拖动模式：`uniform` 匀速 / `ease` 模拟拖动（先加速后减速） |
| `hold` | int | 否 | 0 | 到达终点后保持按住的时间（毫秒），0=立即松开 |
| `windowIndex` | int | 否 | 0 | 目标窗口索引 |

#### 示例

```bash
# 窗口0点击坐标(428, 240)
curl -X POST http://127.0.0.1:38981 -d '{"action":"click","x":428,"y":240,"windowIndex":0}'

# 所有窗口点击
curl -X POST http://127.0.0.1:38981 -d '{"action":"clickAll","x":428,"y":240}'

# 窗口0匀速拖动：从(100,200)拖到(700,400)，耗时500ms
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":200,"toX":700,"toY":400,"duration":500,"mode":"uniform","windowIndex":0}'

# 所有窗口模拟拖动（ease缓动）：从(200,300)拖到(600,150)，耗时800ms
curl -X POST http://127.0.0.1:38981 -d '{"action":"dragAll","fromX":200,"fromY":300,"toX":600,"toY":150,"duration":800,"mode":"ease"}'

# 角色跑动：拖动虚拟摇杆后保持按住2秒
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":400,"toX":300,"toY":400,"duration":200,"hold":2000,"windowIndex":0}'

# 窗口0滚动
curl -X POST http://127.0.0.1:38981 -d '{"action":"scroll","x":428,"y":240,"deltaY":-3,"windowIndex":0}'

# 所有窗口按键回车
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypressAll","code":"Enter"}'

# 窗口0长按W键2秒（手动控制按下/抬起）
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypress","code":"KeyW","down":true,"windowIndex":0}'
sleep 2
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypress","code":"KeyW","down":false,"windowIndex":0}'

# 窗口0粘贴文本
curl -X POST http://127.0.0.1:38981 -d '{"action":"clipboard","text":"hello","windowIndex":0}'
```

### 诊断接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | 获取窗口数量、同步状态、主控窗口 |
| `/diag?win=0` | GET | 获取指定窗口canvas信息 |
| `/devtools?win=0` | GET | 打开指定窗口DevTools |
| `/set-master` | POST | 设置主控窗口 `{"windowIndex": 0}` |

## 技术细节

- 窗口分辨率 853×500，无边框透明窗口
- 同步使用 `sendInputEvent` 直接注入，低延迟
- API坐标转换使用纯数学计算（`getContentSize` + 固定分辨率比例），不依赖canvas缓存
- 窗口标题使用 PowerShell + C# 辅助类设置第二层Chrome窗口标题
- 日志写入exe同目录 `Log.txt`
