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
- 子窗口标题自动锁定（C# TitleLocker后台进程），支持大漠绑定识别

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

### 启动参数

| 参数 | 说明 |
|------|------|
| `--debug` | 调试模式：生成 `Log.txt` 日志文件（exe同目录），记录所有操作和API调用。**不加此参数则不生成日志文件** |
| `--config=路径` | 指定配置文件路径，支持绝对路径和相对路径。不加此参数则自动搜索exe同目录下的 `配置文件.int` |
| `--delay=毫秒` | 窗口创建间隔时间。不加此参数则同时创建所有窗口（默认0）。多窗口时加延迟可避免瞬间资源抢占 |

```bash
# 正常启动（无日志，自动找同目录配置文件）
NoVNC客户端.exe

# 调试模式启动（生成Log.txt）
NoVNC客户端.exe --debug

# 指定配置文件
NoVNC客户端.exe --config=D:\宏聚网络\配置文件.int

# 延迟创建窗口，每个窗口间隔1.5秒
NoVNC客户端.exe --delay=1500

# 组合使用
NoVNC客户端.exe --config=D:\宏聚网络\配置文件.int --delay=1500 --debug

# 开发环境
npm start -- --debug
npm start -- --config=./配置文件.int --delay=1000
```

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

**POST** `/` 请求，JSON格式：

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

### 管理接口

#### POST `/refresh` — 刷新窗口画面

重新加载指定窗口的VNC页面，刷新后自动重设标题并重启TitleLocker。

```bash
# 刷新第1个窗口
curl -X POST http://127.0.0.1:38981/refresh -d '{"windowIndex":1}'
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `windowIndex` | int | 否 | 1 | 窗口编号（1-based） |

返回：`{"ok": true}`

#### POST `/exit` — 退出应用

关闭所有窗口并退出程序。

```bash
curl -X POST http://127.0.0.1:38981/exit
```

返回：`{"ok": true}`

### 查询接口

#### GET `/status` — 获取运行状态

```bash
curl http://127.0.0.1:38981/status
```

返回：

```json
{
  "success": true,
  "windowCount": 5,
  "control": false,
  "master": -1,
  "sync": false,
  "port": 38981
}
```

#### GET `/windows` — 获取窗口列表

返回当前组的所有窗口信息，包括控制IP，供同步器查询。

```bash
curl http://127.0.0.1:38981/windows
```

返回：

```json
{
  "success": true,
  "groupIndex": 1,
  "groupName": "测试组",
  "windowCount": 5,
  "port": 38981,
  "windows": [
    {
      "index": 1,
      "title": "1|172.16.103.16",
      "controlIP": "172.16.103.16",
      "url": "http://172.16.103.16:5801/vnc_lite.html?...",
      "alive": true
    },
    ...
  ]
}
```

#### GET `/diag?win=1` — 诊断窗口canvas信息

获取指定窗口的canvas尺寸和缩放比例，用于调试。

```bash
curl "http://127.0.0.1:38981/diag?win=1"
```

返回：

```json
{
  "canvasW": 1334,
  "canvasH": 750,
  "rectLeft": 0,
  "rectTop": 0,
  "rectW": 856,
  "rectH": 480,
  "scaleX": "1.56",
  "scaleY": "1.56"
}
```

#### GET `/devtools?win=1` — 打开DevTools

打开指定窗口的Chrome开发者工具。

```bash
curl "http://127.0.0.1:38981/devtools?win=1"
```

## 技术细节

- 直接noVNC模式，无边框窗口，GPU硬件加速渲染
- 同步使用 `sendInputEvent` 直接注入，低延迟
- API坐标转换使用纯数学计算（856×480 → 1334×750）
- 子窗口标题通过C# TitleLocker后台进程锁定（SetWinEventHook监听EVENT_OBJECT_NAMECHANGE），刷新后自动重启
- 退出按钮为独立子窗口（parent绑定第一个VNC窗口），切换虚拟桌面时跟随消失
- 默认不生成日志文件，加 `--debug` 参数启动才写 `Log.txt`（缓冲写入，3秒或100条一刷）
- windowIndex 1-based 字符拆分，拖动中断机制，noVNC setCapture 禁用
