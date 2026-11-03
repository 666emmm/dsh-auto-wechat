# dsh-auto-wechat

微信个人号 AI 自动回复，做成 DeepSeek-Harness 插件。

**核心思路：把「看微信」和「想怎么回」拆开。**

| 层 | 谁干 | 在哪 |
|---|---|---|
| 眼睛和手 | RapidOCR 读屏 + PrintWindow 抓图 + PostMessage 点击 + 剪贴板注入 | Python 子进程（无窗口） |
| 调度 | 起停子进程、去重、配置、日志、工具注册 | 本插件（Host 半端） |
| 大脑 | 会话里的模型，带全部 DSH 工具 | DSH 会话 |

原来的做法是把 API key 写进 json、由 Python 直接 `requests.post` 一个模型。这个方案里 Python **一句模型调用都没有**，所以：

- 模型跟着 DSH 会话走，不用再单独配 key
- 回复过程在会话里看得见，可以插话、可以叫停
- 它能用 `web_search`、能翻知识库、能跑命令 —— 因为那就是一个正常的 agent

---

## 安装

```bash
dsh plugin --profile web add github:666emmm/dsh-auto-wechat
```

或从源码目录装：

```bash
git clone https://github.com/666emmm/dsh-auto-wechat
dsh plugin --profile web add ./dsh-auto-wechat
```

装完去 **设置 → 微信自动回复**，先点「下载依赖」（约 330MB，一次性）。

## 依赖说明

RapidOCR 要求 Python `<3.13`，而系统 Python 常是 3.14。所以插件用 [uv](https://docs.astral.sh/uv/) 自己拉一个 3.12 环境：

```
%LOCALAPPDATA%\dsh-auto-wechat\
├── python\   CPython 3.12       (~61MB)
└── venv\     rapidocr + numpy + pillow + pyperclip (~269MB)
```

下载源可改（PyPI / 清华 / 阿里云 / 中科大）。**卸载插件前建议先点「删除依赖」**——插件管理器只删 `node_modules` 里的包，不会碰这个目录。

## 设置页

- **概览**：运行状态 + 三个开关（总开关 / 只读 / 群聊自动回复）+ 依赖项管理 + 实时日志
- **🎭 人设**：私聊人设、群聊人设两套独立（群聊留空则回落到私聊）
- **🌓 白名单**：单聊 / 群聊 / 黑名单三栏 + 节奏（检查间隔、回复延迟）

改了立即生效，不用改 JSON、不用重启、不用再开 Tkinter 控制中心。

## 给会话的工具

| 工具 | 用途 |
|---|---|
| `wechat_status` | 子进程/窗口/会话/开关现状 |
| `wechat_send` | 发一条纯文本（唯一真的发到微信的动作） |
| `wechat_read` | 读某个对话最近的消息 |
| `wechat_contacts` | 出现过的对话 + 对应 DSH 会话 |

## 协议（插件 ↔ Python）

每行一个 JSON，stdin/stdout 双向。

```
→ {"t":"config","config":{...}}                      下发配置
→ {"t":"send","id":"s1","conv":"..","text":".."}     要求发送
→ {"t":"ping"}

← {"t":"ready","python":"3.12.14","pid":123}
← {"t":"state","hwnd":..,"wxver":4,"window":"1100x750"}
← {"t":"observed","conv":"..","kind":"group","msgs":[{"who":"..","text":".."}]}
← {"t":"sent","id":"s1","ok":true}
← {"t":"log","level":"info","msg":".."}
```

**子进程盯着自己的 stdin**：管道一断（插件或 DSH 死了）立即自退。这比心跳简单，也比心跳可靠 —— 不留孤儿进程在后台继续读消息、继续发回复。

## 安全设计

- **单实例互斥体**：Windows 内核 mutex，进程死了系统自动释放。防止两个守护进程同时 OCR 同一条消息 → 调两次模型 → 发两条回复。
- **发送前三重校验**：顶栏标题核对 → 偏了自动纠偏并二次核验 → 绿底气泡增量验收。任一步失败就熔断，绝不盲发。
- **坐标单一来源**：所有「点左侧列表行」都走 `sidebar_row_click_x()`，禁止写死比例（群聊行高与好友不同，固定比例会点偏）。
- **只读模式**：识图、推进会话，但 `wechat_send` 被拦下。
- **群聊单独开关**：默认关闭。群里说错话是全群可见的。

## 和原项目的关系

由 [Luofeng-Cloud/WeChat-AI-AutoReply](https://github.com/Luofeng-Cloud/WeChat-AI-AutoReply)（MIT）演化而来，沿用了它的视觉感知与 Win32 无痕挂载思路。主要改动：

1. 去掉内置 LLM 调用，改成上报给 DSH 会话
2. 加 stdio 协议层 + 孤儿进程自退
3. 加单实例互斥体（修「重复回复」）
4. 统一点击坐标为单一来源（修「群聊发送总熔断」）
5. 去掉 Tkinter GUI，设置搬进 DSH
6. 配置文件只留业务字段，不含任何 API key

## License

MIT
