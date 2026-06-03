# NoVNC 群控客户端

基于Electron的NoVNC多窗口群控客户端，用于梦幻西游多开VNC远程操控。支持多窗口同步操作、HTTP API外部控制、大漠DX绑定抓图。

## 特性

- 无边框窗口，仅显示NoVNC远程桌面画面
- GPU硬件加速渲染，画面流畅低延迟
- 启动自动加载指定NoVNC地址，无需手动输入
- 多窗口同步操作：主控窗口输入自动同步到其他窗口
- HTTP API外部控制：支持点击、拖动、滚轮、按键、粘贴等指令
- 灵活的windowIndex参数：单窗口、多窗口、群控一参搞定
- 屏幕右下角退出按钮，每个窗口右下角刷新按钮
- 子窗口标题自动设置（Chrome_RenderWidgetHostHWND），支持大漠绑定识别

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
npm install
npm start
```

### 打包

```bash
npm run build:win
```

打包完成后在 `dist` 目录下生成可执行文件。

## 同步操作

点击右下角"同步"按钮开启同步模式。开启后：

- 主控窗口（默认窗口1）的鼠标、键盘、滚轮操作会同步到其他窗口
- 每个窗口右下角出现"主控"按钮，点击可切换主控窗口
- 主控窗口按钮显示绿色"主控✓"，非主控窗口显示灰色"主控"

再次点击按钮关闭同步。

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

#### 示例

```bash
# 第1个窗口点击坐标(428, 240)
curl -X POST http://127.0.0.1:38981 -d '{"action":"click","x":428,"y":240,"windowIndex":"1"}'

# 群控全部5个窗口点击
curl -X POST http://127.0.0.1:38981 -d '{"action":"click","x":428,"y":240,"windowIndex":"12345"}'

# 第1个窗口匀速拖动
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":200,"toX":700,"toY":400,"duration":500,"mode":"uniform","windowIndex":"1"}'

# 群控全部窗口模拟拖动（ease缓动）
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":200,"fromY":300,"toX":600,"toY":150,"duration":800,"mode":"ease","windowIndex":"12345"}'

# 角色跑动：拖动虚拟摇杆后保持按住2秒
curl -X POST http://127.0.0.1:38981 -d '{"action":"drag","fromX":100,"fromY":400,"toX":300,"toY":400,"duration":200,"hold":2000,"windowIndex":"1"}'

# 手动释放左键
curl -X POST http://127.0.0.1:38981 -d '{"action":"release","windowIndex":"1"}'

# 群控全部窗口按键回车
curl -X POST http://127.0.0.1:38981 -d '{"action":"keypress","code":"Enter","windowIndex":"12345"}'

# 第1个窗口粘贴文本
curl -X POST http://127.0.0.1:38981 -d '{"action":"clipboard","text":"hello","windowIndex":"1"}'
```

### 诊断接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/status` | GET | 获取窗口数量、同步状态、主控窗口 |
| `/diag?win=1` | GET | 获取指定窗口canvas信息（1-based编号） |
| `/devtools?win=1` | GET | 打开指定窗口DevTools（1-based编号） |
| `/set-master` | POST | 设置主控窗口 `{"windowIndex": 1}` |

## 技术细节

- 直接noVNC模式，无边框窗口，GPU硬件加速渲染
- 同步使用 `sendInputEvent` 直接注入，低延迟
- API坐标转换使用纯数学计算（856×480 → 1334×750）
- 子窗口标题通过 PowerShell + C# 设置（Chrome_RenderWidgetHostHWND / Chrome Legacy Window 自动匹配）
- 退出按钮为独立子窗口（parent绑定第一个VNC窗口），切换虚拟桌面时跟随消失
- 日志写入exe同目录 `Log.txt`
- windowIndex 1-based 字符拆分，拖动中断机制，noVNC setCapture 禁用
