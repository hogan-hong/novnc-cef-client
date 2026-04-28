# NoVNC 群控客户端

基于Electron开发的NoVNC群控客户端，支持多窗口同时操作、主控窗口同步、HTTP API外部控制。

## 特性

✅ 无标题无边框窗口，仅显示NoVNC远程桌面画面
✅ 全GPU硬件加速渲染，画面流畅低延迟
✅ 启动自动加载指定NoVNC地址，无需手动输入
✅ 多窗口同步操作：主控窗口输入自动同步到其他窗口
✅ 主控窗口切换：点击窗口内"主控"按钮切换主控源
✅ HTTP API外部控制：支持通过API发送点击、滑动、键盘等指令
✅ 灵活的windowIndex参数：单窗口、多窗口、群控一参搞定
✅ 可打包成单文件便携版，无需安装直接运行

## 使用方法

### 配置文件

将 `配置文件.int` 放在exe同目录下，格式示例：

```ini
组1名称=测试组
URL1=http://172.16.103.16:5801/vnc_lite.html?autoconnect=true&host=172.16.103.16&port=5901&encrypt=0
窗口标题1=手机1
控制IP1=172.16.103.16
URL2=http://172.16.103.17:5801/vnc_lite.html?autoconnect=true&host=172.16.103.17&port=5901&encrypt=0
窗口标题2=手机2
控制IP2=172.16.103.17
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

- 主控窗口（默认窗口1）的鼠标、键盘、滚轮操作会同步到其他窗口
- 每个窗口右下角出现"主控"按钮，点击可切换主控窗口
- 主控窗口按钮显示绿色"主控✓"，非主控窗口显示灰色"主控"

### 关闭同步

再次点击右下角按钮（此时显示"关闭同步"）即可关闭。

## HTTP API

启动后自动开启HTTP API服务，端口为 `38980 + 组号`（如第1组端口38981，第2组端口38982）。

### 坐标系统

API坐标基于客户端横屏分辨率 **856×480**，超出此范围的坐标将被忽略。内部自动转换为手机实际分辨率 **1334×750**。

### windowIndex 参数说明

`windowIndex` 是**字符串类型**，编号从 **1** 开始，每个字符代表一个窗口编号（1-5），支持单窗口、多窗口、群控：

| 传参 | 效果 | 说明 |
|------|------|------|
| `"1"` | 控制第1个窗口 | 单窗口 |
| `"5"` | 控制第5个窗口 | 单窗口 |
| `"13"` | 同时控制第1、3个窗口 | 多窗口 |
| `"15"` | 同时控制第1、5个窗口 | 多窗口 |
| `"12345"` | 群控全部5个窗口 | 全部窗口 |

> 编号从1开始，和日常直觉一致：1=第1个窗口，5=第5个窗口。每批最多5个窗口（1-5），不会有双位数，直接把字符串按字符拆开即可解析。

### 控制命令

**POST** 请求，JSON格式：

```json
{
  "action": "click",
  "x": 428,
  "y": 240,
  "windowIndex": "1"
}
```

#### 支持的 action

| action | 说明 | 参数 |
|--------|------|------|
| `click` | 左键单击 | x, y, windowIndex |
| `rightclick` | 右键单击 | x, y, windowIndex |
| `drag` | 左键拖动 | fromX, fromY, toX, toY, duration, mode, hold, windowIndex |
| `release` | 释放左键 | x, y, windowIndex |
| `scroll` | 滚轮 | x, y, deltaY, deltaX, windowIndex |
| `keypress` | 按键 | code, down, windowIndex |
| `clipboard` | 粘贴文本 | text, windowIndex |

#### release 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `x` | int | 否 | 0 | 释放坐标X |
| `y` | int | 否 | 0 | 释放坐标Y |
| `windowIndex` | string | 否 | "1" | 目标窗口 |

> 三重释放机制：`sendInputEvent` mouseUp + canvas `dispatchEvent` mouseup + 隐藏 capture proxy，确保 VNC 侧左键完全释放。适用于 drag 后左键卡住不弹起时手动调用。

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
| `windowIndex` | string | 否 | "1" | 目标窗口 |

#### scroll 参数说明

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `x` | int | 否 | 0 | 滚轮位置X |
| `y` | int | 否 | 0 | 滚轮位置Y |
| `deltaY` | int | 否 | 0 | 垂直滚动格数，正数=向下，负数=向上（1=滚1格） |
| `deltaX` | int | 否 | 0 | 水平滚动格数，正数=向右，负数=向左（1=滚1格） |
| `windowIndex` | string | 否 | "1" | 目标窗口 |

> **注意**：scroll 不受越界检查限制，坐标只是定位用。deltaY/deltaX 为**滚动格数**（非像素），VNC 协议只支持逐格滚动，内部自动拆分为多次事件发送，传 3 就滚 3 格。

#### 示例

```bash
# 第1个窗口点击坐标(428, 240)
curl -X POST http://127.0.0.1:38981 -d '{"action":"click","x":428,"y":240,"windowIndex":"1"}'

# 同时控制第1和第3个窗口点击
curl -X POST http://127.0.0.1:38981 -d '{"action":"click","x":428,"y":240,"windowIndex":"13"}'

# 群控全部5个窗口点击
curl -X POST http://127.0.0.1:38981 -d '{"action":"click","x":428,"y":240,"windowIndex":"12345"}'

# 第1个窗口匀速拖动：从(100,200)拖到(700,400)，耗时500ms
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":200,"toX":700,"toY":400,"duration":500,"mode":"uniform","windowIndex":"1"}'

# 群控全部窗口模拟拖动（ease缓动）
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":200,"fromY":300,"toX":600,"toY":150,"duration":800,"mode":"ease","windowIndex":"12345"}'

# 同时控制第1、3窗口拖动
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":200,"toX":700,"toY":400,"windowIndex":"13"}'

# 角色跑动：拖动虚拟摇杆后保持按住2秒
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":400,"toX":300,"toY":400,"duration":200,"hold":2000,"windowIndex":"1"}'

# 手动释放左键（drag后左键卡住时使用）
curl -X POST http://127.0.0.1:38981 -d '{"action":"release","windowIndex":"1"}'

# 释放全部窗口左键
curl -X POST http://127.0.0.1:38981 -d '{"action":"release","windowIndex":"12345"}'

# 第1个窗口向下滚动3行
curl -X POST http://127.0.0.1:38981 -d '{"action":"scroll","x":428,"y":240,"deltaY":3,"windowIndex":"1"}'

# 群控全部窗口向上滚动5行
curl -X POST http://127.0.0.1:38981 -d '{"action":"scroll","x":428,"y":240,"deltaY":-5,"windowIndex":"12345"}'

# 群控全部窗口按键回车
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypress","code":"Enter","windowIndex":"12345"}'

# 第1个窗口长按W键2秒（手动控制按下/抬起）
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypress","code":"KeyW","down":true,"windowIndex":"1"}'
sleep 2
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypress","code":"KeyW","down":false,"windowIndex":"1"}'

# 第1个窗口粘贴文本
curl -X POST http://127.0.0.1:38981 -d '{"action":"clipboard","text":"hello","windowIndex":"1"}'

# 同时控制第1、3窗口粘贴文本
curl -X POST http://127.0.0.1:38981 -d '{"action":"clipboard","text":"hello","windowIndex":"13"}'
```

### 诊断接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | 获取窗口数量、同步状态、主控窗口 |
| `/diag?win=1` | GET | 获取指定窗口canvas信息（1-based编号） |
| `/devtools?win=1` | GET | 打开指定窗口DevTools（1-based编号） |
| `/set-master` | POST | 设置主控窗口 `{"windowIndex": 1}` |

## 技术细节

- 窗口分辨率 853×500，无边框透明窗口
- 同步使用 `sendInputEvent` 直接注入，低延迟
- API坐标转换使用纯数学计算（`getContentSize` + 固定分辨率比例），不依赖canvas缓存
- 窗口标题使用 PowerShell + C# 辅助类设置第二层Chrome窗口标题
- 日志写入exe同目录 `Log.txt`
- **windowIndex 1-based 字符拆分**：编号从1开始（1=第1个窗口，5=第5个窗口），`windowIndex` 传字符串，每个字符代表一个窗口编号，如 `"13"` 同时控制窗口1和3，`"12345"` 群控全部
- **拖动中断机制**：click/scroll 等操作执行前会自动中断同窗口未完成的 drag（取消定时器+释放左键），确保操作立即生效
- **noVNC setCapture 禁用**：启动时自动禁用 noVNC 的 `setCapture` 机制，避免 capture proxy 干扰 `sendInputEvent` 导致左键不弹起
