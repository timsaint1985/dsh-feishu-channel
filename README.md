# dsh-feishu-channel

飞书 / Lark 通道插件（DeepSeek Harness）。让 **飞书消息驱动 DSH agent 会话**，
并把 agent 的回复发回飞书。

> 注意方向：本插件是「**飞书 → DSH**」（被飞书驱动）。
> 如果你要的是「DSH → 飞书」（主动读写飞书文档/表格/消息），用官方的
> `lark-cli` + `lark-*` skill，与本插件互补、不冲突。

## 特性

- **用户白名单**，fail-closed（名单为空则拒绝一切消息）
- **每个飞书会话一个独立、持久的 DSH Session**（`chat_id → sessionId` 绑定可持久化）
- 完整的 **agent 工具能力**（文件、shell、web、subagent、skill、定时任务…）
  —— 因为消息直接进 agent loop，与 Web GUI 共用同一套运行时能力
- **审批**：agent 需要沙箱提权时发飞书卡片；卡片按钮 + 文本回复两条决策路径
- 审批超时 **fail-closed**（默认 5 分钟，可配），未获批绝不越权
- **零外部依赖**：只用 Node 内置模块；收发通过 spawn `lark-cli` 复用已有授权

## 快速安装（推荐）

```powershell
# 在插件目录下执行；把 <profile> 换成你要装进去的 profile（例如 web）
.\install.ps1 -Profile <profile>
```

脚本会自动处理「路径含空格导致 pnpm `file:`/`link:` 规格被截断」这个坑
（建 junction），装进 profile，并打印你还需要手填的配置模板。

装完接着做两件事：
1. 把 `cordis.patch.example.yml` 填好，粘进
   `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`
2. 重启该 profile

> ⚠️ 如果你要装进**同时开着浏览器界面**的 profile（如 `web`），
> 注意两个审批应答者不能互相指望：本插件用 `prepend` 排在最前，且会一直等到
> 超时（默认 5 分钟），排在其后的 `ui-approval` 根本没有机会执行。
>
> - 想让**通道 agent 的审批走飞书** → 保留模板里的 `disabled: true`（推荐）
> - 想让**通道 agent 的审批弹在浏览器** → 删掉 `disabled: true`，
>   并把 `answerApprovals` 设为 `false`（本插件就完全不注册应答者）
>
> 详见 [DESIGN.md](DESIGN.md) 的 M10。

下面是手动步骤，供排障时参考。

## 安装

### 1. 前置条件

- 已安装并授权 `lark-cli`，且有一个可用 profile：

  ```bash
  lark-cli auth status --profile <你的 app profile>
  ```

- 该飞书应用已开启**机器人能力**并发布，且已启用**长连接**事件订阅
  （应用 → 事件与回调 → 事件配置 → 长连接）。

### 2. 装进 profile

```bash
dsh plugin --profile <profile> add <本目录路径或包名>
```

`dsh plugin` 只是转发给 pnpm，但它**会自动把包名加进 profile 的
`dsh.profile.bundles`**，所以一条命令就够。

> ⚠️ **`file:` 是快照，`link:` 才是实时链接。**
> `file:` 把包**拷贝/硬链接**进 `node_modules`（安装那一刻的版本）；
> 之后改源文件，profile 里跑的仍是旧副本 —— 非常容易误判成「代码改了没生效」。
> 本地开发请用 `link:`：
>
> ```bash
> dsh plugin --profile <profile> add "link:C:/无空格的路径/feishu-channel"
> ```
>
> 分发（发布 npm 包或冻结版本）时用 `file:` 或版本号才是正确的。

> ⚠️ **路径含空格会让 pnpm 的 `file:`/`link:` 规格被截断**
> （`E:/my plugins/feishu-channel` → 找不到 `E:/my`）。
> 用目录联结给一个无空格路径：
>
> ```powershell
> New-Item -ItemType Junction -Path C:\dsh-local-plugins\feishu-channel `
>   -Target 'E:\my plugins\feishu-channel'
> dsh plugin --profile <profile> add link:C:/dsh-local-plugins/feishu-channel
> ```

### 3. 在 profile 的 `cordis.patch.yml` 里配置

```yaml
# 无头通道场景：关掉 web UI 的审批应答者。
# 它接管 approval/request 后会一直等浏览器点击、永不返回。
- id: ui-approval
  disabled: true

- id: feishu-channel
  config:
    profile: cli_xxxxxxxxxxxx          # lark-cli profile
    allowedOpenIds:                    # 白名单，必填，空 = 拒绝一切
      - ou_xxxxxxxxxxxxxxxxxxxxxxxx
    workspacePath: 'E:\你的工作区'
    agentPreset: standard                # 决定 agent 有哪些工具，必填
    provider: deepseek-official          # 程序化创建的 agent 不会继承默认模型
    model: deepseek-v4-flash             # 必须用支持工具调用的模型
    autoConnect: true
```

> ⚠️ profile 层的 patch **替换整个 config**，不是深合并 —— 覆盖时要重述所有需要的字段。

## 打包与分发

本插件就是一个标准 npm 包，用 `npm pack` 打成 `.tgz` 即可分发：

```powershell
cd <插件目录>
npm pack --pack-destination C:\dsh-local-plugins
# → dsh-feishu-channel-0.1.0.tgz
```

安装方只要：

```powershell
dsh plugin --profile <profile> add file:C:/dsh-local-plugins/dsh-feishu-channel-0.1.0.tgz
```

**tgz 可以直接放在含空格的路径吗？** 不行 —— 规格字符串里的空格同样会被截断。
把 tgz 放到无空格的目录再安装。

### 开发用 `link:`，发布用 `.tgz`

| 场景 | 用什么 | 为什么 |
|---|---|---|
| **本地开发** | `link:<源码目录>` | 实时链接，改源码重启即生效 |
| **分发给别人 / 冻结版本** | `file:<xxx.tgz>` | 自包含快照，不受源码变动影响 |

判断当前是哪种：`Get-Item <profile>\node_modules\dsh-feishu-channel | Select LinkType`
—— `Junction`/`SymbolicLink` 是实时链接；空是解包快照。

> ⚠️ 用 `.tgz` 装完之后**再改源码是不会生效的**（node_modules 里是冻结副本）。
> 要重新打包并重装，或切回 `link:`。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `larkCli` | npm 全局安装的 `lark-cli.exe` | lark-cli 可执行文件路径 |
| `profile` | — | lark-cli profile（决定用哪个飞书应用） |
| `allowedOpenIds` | `[]` | **用户白名单**。空数组 = 拒绝一切（安全默认） |
| `workspacePath` | — | 新会话的工作目录 |
| `sessionPrefix` | `sess-feishu` | 会话 id 前缀；改它可强制新建会话 |
| `agentPreset` | `standard` | **必须设置**，否则 agent 没有工具 |
| `provider` / `model` | `''` | 模型路由。**不设则 agent 无法工作** |
| `bindingsFile` | — | `chat_id → sessionId` 绑定持久化位置 |
| `allowGroupChats` | `false` | 群聊（v1 默认关闭） |
| `autoConnect` | `true` | 启动时是否连飞书长连接 |
| `approvalTimeoutMs` | `300000` | 审批等待点击的超时；超时按 `unavailable` fail-closed |
| `selfTest` | `{enabled:false}` | 自测入口：启动 3 秒后注入合成消息 |

## 排障

### 消息没反应

```bash
lark-cli event status --json --profile <profile>
```

看 `active_consumers` 与 `received`。消费者在跑但 `received` 一直为 0 →
飞书侧没投递，检查应用的事件订阅是否开了长连接。

### 卡片按钮点不动

**这是最常见的问题，且几乎总是开放平台配置问题，不是代码问题。**

`card.action.trigger` 需要在 **应用 → 事件与回调 → 回调配置** 里开启。
官方文档明确警告：**没开的话消费者照样启动成功、没有预检、事件永远不来。**

验证方式：

```bash
lark-cli event status --json --profile <profile>   # 看 card.action.trigger 的 received
```

一直是 0 = 从未收到回调。

**兜底**：本插件同时支持**文本回复决定审批**。为了不把正常消息里的
「ok」「可以」误当成批准（也会让同 chat 的多笔挂起审批无法区分），
**回复必须带审批 id** —— 插件在发卡片时会同时发一条文本，里面写明了要回复的内容：

```
允许 ap-3-ab12
拒绝 ap-3-ab12
```

只有**唯一一笔**挂起审批时，才接受不带 id 的简写
（「允许 / 同意 / 批准 / 拒绝 / 不允许 / 不行」）。
即使不启用回调配置，审批功能也可用。

### agent 只回文字、不执行工具

十有八九是 `agentPreset` 没设**或**没有在 `setup(agentCtx)` 里
`ctx.agentPresets.mount()`。见 DESIGN.md 的 Bug 5。

### 回复里混着 `｜｜DSML｜｜ invoke` 之类的标记

回复正文必须取**已提交的** `assistant/message`
（`agentCtx.on('session/event', ...)` 过滤 `assistant/message`，只取 text 块），
**不能**用流式 `text-delta` 累积。

### agent 卡在 running 不结束

检查 profile 里是否有别的审批应答者（尤其 `ui-approval`）先接管了
`approval/request` waterfall —— 它会等浏览器点击、永不返回。

## 安全

**能跟这个机器人说话 = 能在你的机器上驱动 agent 执行命令。**

- `allowedOpenIds` 是硬门槛，不要留空以外的宽松值
- 群聊场景务必只在被 @ 时响应，并限定群
- 审批卡片不得被绕过；`unavailable` 时保持 fail-closed
- 插件跑在 DSH 宿主进程内，所有回调都包了 try/catch

## 相关文件

- `index.mjs` —— 插件本体
- `cordis.patch.yml` —— bundle 层（声明入口）
- `DESIGN.md` —— 设计说明与完整实测记录（含 6 个已修 bug 的根因）
