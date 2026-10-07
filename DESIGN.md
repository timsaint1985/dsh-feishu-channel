# DSH 飞书通道插件 — 设计与 API 调研

> 状态：调研完成，v1 实现中
> 日期：2026-09-30
> 依据：本机已安装的 `@deepseek-ai/dsh` v0.1.5-rc.2 的 README 与 `.d.ts`（非猜测）

## 目标

飞书消息 → 驱动 DSH agent 会话；agent 回复 → 发回飞书。含用户白名单与审批卡片。

## 一、已验证的 API 面

### 1. 插件装配

- profile 位于 `$DSH_HOME/profiles/<name>`，由 `package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml` 叠加组成
- patch 条目格式：`{ id, name, config }`
- **`name` 可以是绝对文件路径**（app-boot README）→ 无需打包成 npm 包
- patch 定位条目时**替换整个 config**，不做深合并
- **空文件或仅注释的 patch 会导致启动失败**，禁用该层要用 `[]`
- `patchReload: live` 时改 patch 会热重载

插件模块导出约定（来自 `dsh-free-vision/dsh/index.js`）：

```js
export const name = 'feishu-channel'
export const inject = ['...']          // 可选，声明依赖的服务
export const Config = z.object({...})  // 可选，web 设置界面会自动渲染成表单
export function apply(ctx, config) {}
```

### 2. 创建与驱动 agent — `@deepseek-ai/dsh-agent`

`ctx.agents` 是 `AgentRegistry`：

| 方法 | 签名 |
|---|---|
| `create` | `(options: CreateAgentOptions) => Promise<AgentHandle>` |
| `resume` | `(options: ResumeAgentOptions) => Promise<AgentHandle>` |
| `get` | `(id: SessionId) => Agent \| undefined` |
| `list` / `roots` | `() => Agent[]` |

`AgentHandle = { agent: Agent, dispose(): Promise<void> }`

`CreateAgentOptions`：
- `sessionId`（必填，agent 与 session 共用同一 id）
- `meta?: { cwd?, parentSession?, agentPreset?, ... }`
- `agentOptions?: { provider?, model?, reasoningEffort?, maxTokens? }`
- `setup?: (agentCtx, agent) => ...` — 只做组合，不驱动

`Agent` 方法：

| 方法 | 语义 |
|---|---|
| `followup(message)` | 排队一个普通下一轮并唤醒驱动器 |
| `steer(message)` | 送到最近一个 step 边界 |
| `inject(message)` | 只加模型可见上下文，不唤醒 |
| `cancel(cause, opts?)` | `opts.keepInbox` 保留待处理项 |
| `whenIdle()` | 等到整个 agent 完全停稳 |

**注意**：`followup` 等方法都定义在 `runtime-types.d.ts` 的 `declare module './types.ts'` 里，所以类型上挂在 `Agent` 上。

### 3. 消息结构 — `@deepseek-ai/dsh-llm`

```ts
interface Message {
  id: MessageId
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
  source: MessageSource
}
interface UserMessage extends Message { role: 'user' }
type MessageSource = { kind: 'user' } | { kind: 'plugin', plugin: string, form: ... } | ...
```

官方 README 示例（可直接照抄的形状）：

```js
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
```

工厂函数（不能从插件里 import 时需自行兜底）：`createUserMessage({ content, source })` 负责铸造 `id`。
`MessageId(id: string)` 只是编译期 brand，运行时是普通字符串。

### 4. 观察 agent 输出 — 事件

全部是 scope-filtered 事件，agent 作用域监听器只收到该 agent 的事件。

```ts
'agent/assistant-stream'(payload: { agent, frame: AssistantStreamFrame })
```

`AssistantStreamFrame`：
- `{ type: 'start', attemptId, revision, turn, step }`
- `{ type: 'chunk', attemptId, revision, index, time, chunk: StreamChunk }`
- `{ type: 'end', attemptId, revision, index, outcome: {kind:'committed', eventType, seq} | {kind:'abandoned'} }`

`StreamChunk` 里取文本：`{ type: 'text-delta', index, text }`

其它可用事件：`agent/created`、`agent/disposed`、`agent/status`、`agent/session-start`、`agent/pre-step`（waterfall，可拒绝/替换步骤）、`agent/turn-stopping`（serial，可 steer 保持轮次开启）、`agent/error`。

### 5. 审批 — `@deepseek-ai/dsh-user-approval`

- 应答者是 **`approval/request` waterfall 监听器**：返回结果即应答，否则 `next()` 委托
- **可限定到单个 agent**（每项部署应组合一个最终应答者）
- 结果词汇：`allowed-once` / `rejected` / `cancelled` / `unavailable`
  （依据 `dsh-user-approval/lib/types/types.d.ts:26`；**不是 `denied`**）
- 无应答者时 → `unavailable`，**以拒绝方式关闭**（fail-closed）
- 请求只在**未结束的轮次内**有效
- 会话策略：`ask`（默认）/ `never`

> 待补：`approval/request` 结果的确切运行时形状（`{kind:'allowed-once'}` 还是别的），需读 `dsh-user-approval/lib/types/*.d.ts`。

### 6. 其它可复用能力

- `dsh-webhook`：`ctx.webhookRuntime.register(rule)` / `dispatch(delivery)`，规则返回 `WebhookSessionRequest` → 创建 Workspace + Agent + Session
- `dsh-webhook-github`：适配器包**参考实现**（签名校验 + 规则注册）
- `dsh-host-webserver`：进程内 HTTP 服务，可用于 webhook 模式
- `dsh-attachment` / `dsh-attachment-local`：附件

## 二、v1 架构

```
飞书用户
   │  私聊/群里 @机器人
   ▼
飞书长连接 (im.message.receive_v1)
   ▲
   │ 子进程 spawn，读 NDJSON stdout
   │
┌──┴─────────────────────────────────────────┐
│ DSH 插件 feishu-channel（跑在 DSH 进程内）  │
│                                             │
│  白名单校验 (sender_id ∈ allowedOpenIds)     │
│        │                                    │
│  会话绑定 chat_id → sessionId               │
│        │                                    │
│  ctx.agents.create() / 复用 AgentHandle      │
│        │                                    │
│  agent.followup({content, source})          │
│        │                                    │
│  监听 agent/assistant-stream                │
│  累积 text-delta → end 帧                    │
│        │                                    │
│  回发：lark-cli im +messages-reply          │
└─────────────────────────────────────────────┘
```

**为什么用 lark-cli 子进程而不是飞书 SDK**：零新增依赖、复用已授权的
飞书应用（bot + user 双身份），插件本身除了 Node 内置模块不需要任何 import。

**关键坑**：spawn 时必须从子进程环境里**删掉 `HERMES_HOME`**，否则 lark-cli 会去读
`.lark-cli/hermes/config.json`（另一个应用），而不是我们要的默认配置库。
npm 的 `lark-cli.cmd` 包装脚本正是靠 `set "HERMES_HOME="` 做到这一点的。

## 三、迭代计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 白名单 + 会话绑定 + 文本双向 | 进行中 |
| 2 | 审批卡片（`approval/request` → 飞书卡片 → 点击回传） | 待做 |
| 3 | 图片/文件双向 | 待做 |
| 4 | 进度反馈、幂等、长回答分片、绑定持久化 | 待做 |

## 四、安全约束（不可妥协）

- **白名单是硬门槛**：能跟机器人说话 = 能在本机驱动 agent 执行命令
- 群聊只在被 @ 时响应
- 审批卡片不得被绕过；`unavailable` 时保持 fail-closed
- 插件跑在 DSH 进程内，任何未捕获异常都可能影响宿主 → 所有回调必须包 try/catch

## 五、v1 实测记录（2026-09-30）

**状态：文本双向链路已端到端打通并验证。**

验证方式：插件内置 `selfTest`，启动 3 秒后注入一条合成入站事件，跑通
「白名单 → 建会话 → 驱动 agent → assistant-stream → 回发飞书」全下游逻辑。
结果：agent 产出 8 个字符，飞书聊天里出现机器人回复「飞书通道已接通。」。

### 开发期踩到的 4 个坑（都已修）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 启动失败：`cannot get property "agents" without inject` | Cordis 的 `ctx` 是 Proxy，访问未声明依赖的服务直接抛 | `export const inject = ['agents']` |
| 2 | lark-cli 读到了错误的飞书应用 | spawn 子进程继承了 `HERMES_HOME`，lark-cli 转去读 `.lark-cli\hermes\config.json` | `delete env.HERMES_HOME` |
| 3 | 轮次失败：`prompt variable "{{model}}" has no value` | 传了空的 `agentOptions: {}`，**覆盖掉** profile 里 `agent-default-model` 的默认值 | 没有显式路由时**不传该字段**；或显式给 `provider`/`model` |
| 4 | 收不到 agent 输出 | `agent/*` 是 **scope-filtered** 事件，注册在根 `ctx` 上收不到 | 注册在该 agent 自己的 `agent.ctx` 上 |

补充：`profile 默认模型不会自动应用到 ctx.agents.create() 创建的 agent`——
即使不传 agentOptions 也一样。**必须显式传 provider/model**（当前配置
`deepseek-official` / `deepseek-flash`）。

### 已知待修（v1 阶段）

- `@deepseek-ai/dsh-llm` 无法从插件所在路径解析 → `createUserMessage` 工厂
  加载失败（`factoryLoaded: false`），当前走字面量兜底。功能正常，但更好的是把
  插件放进 profile 的 node_modules 闭包。
- 引用回复（`+messages-reply`）对合成 message_id 会失败并退化为普通发送；
  真实消息下应正常。
- `patchReload: live` 对**文件路径插件**只重跑 `apply`，**不刷新 ESM 模块缓存**
  → 改插件代码必须重启进程才生效。

## 六、v2 实测记录（2026-09-30 下午）—— 两个致命 bug 已修

**状态：文本双向 + 工具调用 + 干净回复，全部验证通过。**

### Bug 5（最隐蔽）：agent 没有工具，模型把工具调用吐成纯文本

**现象**：agent 能建会话、能跑完一轮、也能回复，但**从不执行任何工具**。
回复里出现 `｜｜DSML｜｜ invoke name="shell"` 这种原始标记；
会话投影里 `tool/call = 0` —— 模型从未产出被解析的工具调用。

**排查路径**（值得记下来）：
1. 先怀疑模型不支持工具调用 → 换成 `deepseek-v4-flash`，无效
2. 用 `dsh --profile headless "建个文件"` 做**隔离实验** → headless 完全正常，
   文件真的被创建。说明工具调用本身没问题，问题只在 `ctx.agents.create` 这条路径
3. 读 `dsh-agent-presets` 文档找到答案

**根因**：会话的工具/提示词/skill 全部由 agent preset 的 `agent.cordis.yml` 装配。
`meta.agentPreset` 只是记了个名字，**真正的挂载必须发生在
agent factory 的 `setup(agentCtx)` 钩子里**。文档原话：

> 它不决定 agent 何时创建 —— **agent factory 的 `setup(agentCtx)` 钩子是唯一
> 受支持的调用点**，因为只有在那里，join 才会在 agent 尚未发布时装上。

**正确写法**：

```js
await ctx.agents.create({
  sessionId,
  meta: { cwd, agentPreset: 'standard' },
  agentOptions: { provider, model },
  setup: async (agentCtx) => {
    await ctx.agentPresets.mount(agentCtx, 'standard')   // ← 缺这行就没有工具
  },
})
```

插件同时要 `export const inject = ['agents', 'agentPresets']`。

**验证**：工作区内的文件被真实创建（2 字节，内容 `ok`）。

### Bug 6：回复正文夹带原始工具调用标记

**现象**：`agent/assistant-stream` 的 `text-delta` 累积出的文本混着
`｜｜DSML｜｜ calls>` 标记，直接发给用户就是乱码。

**根因**：流式增量是模型原始输出，包含工具调用语法。

**修法**：回复正文改取**已提交的** assistant 消息 —— 监听
`agent.ctx.on('session/event', ...)`，过滤 `event.type === 'assistant/message'`，
从 `event.data.message.content` 中只取 `type === 'text'` 的块。

流式帧只保留计数用途；回发由 `agent/status === 'idle'` 触发（带幂等保护）。

**验证**：回复变成干净的 197 字符中文，无任何标记。

### 仍未验证 / 待查

- **审批卡片链路**。`approval/request` 已按 agent 作用域注册，但在
  「往工作区外写文件」的测试中，agent 卡在 `running` 超过 2 分钟，
  **既没有 `approvalRequest` 状态、也没有报错**。
  待查方向：
  1. 沙箱层在写工作区外时是否直接挂住（本机沙箱 ACL 本就有已知问题）
  2. `approval/request` 的 waterfall 分发作用域是否真的与 `agent.ctx` 一致
  3. 是否需要 `inject` 里加上 approval 相关服务

## 七、v3 排查记录（2026-09-30 傍晚）—— 审批链路的确切卡点

### 已确认的事实

1. **`ui-approval` 是「卡死」的元凶**。profile 的配置 dump 第 485 行挂着
   `- id: ui-approval / @deepseek-ai/dsh-client-ui-approval` —— web UI 的
   审批应答者。它接管 waterfall 后会一直等浏览器点击，没人点就永不返回，
   后面的应答者根本没机会跑。**已在本 profile 里 `disabled: true` 关掉**，
   关掉之后 agent 不再卡死、回合正常结束。

2. **审批链路本身是好的**。用 `dsh --profile headless` 做同样「工作区外写入」：
   8.2 秒就返回，agent 明确报告
   「申请提权到 danger-full-access 时**当前没有可用的审批通道，请求按策略
   直接失败关闭**」。即无应答者时按 fail-closed 快速返回，不会挂。

3. **但我的监听器收不到 `approval/request`**，两种注册方式都试过：
   - `agent.ctx.on(...)`（create 返回后注册）→ 收不到
   - `agentCtx.on(...)`（在 `setup(agentCtx, agent)` 钩子里注册）→ **仍收不到**
   - 另外在**根 ctx** 上挂了一个只观察、调 `next()` 委托的探针 → **也收不到**

   而 agent 侧的反馈是「审批被**取消**」（`cancelled`），说明请求确实发生过，
   只是被结算掉了，从没进到我的瀑布监听器。

### 推断

preset 挂在 **isolate realm** 之后（`dsh-agent-presets` 文档：
「`serviceForAgent` 读取某 agent 对其 preset 挂在 `isolate` realm 之后的某个
服务实例」）。`approval/request` 很可能在这个隔离 realm 内分发，因此
**从插件树外部注册的监听器（无论根 ctx 还是 agentCtx）都进不了那条瀑布**。

### 下一步方向

- 把审批应答者做成**preset 组装内的一行**（放进 `agent.cordis.yml`），
  让它天然处在同一个 realm 里；而不是从独立插件外部去监听
- 或者查 `dsh-user-approval` 的 `ApprovalService` 是否提供了跨 realm 注册应答者的
  公开接口（目前只看到 waterfall 监听这一条路）
- 备选降级方案：不接管审批，改为在飞书里提示「本操作需要审批，请在 DSH Web UI
  确认」，即接受通道场景下审批不可用

### 本轮的其它修复

- agent 作用域监听器改到 `setup(agentCtx, agent)` 里注册（此前在 create 返回后
  往 `agent.ctx` 注册）——回合不再卡死，回复正常
- 审批监听器加 `prepend: true`（备用路径，当前未生效因为压根没进瀑布）

## 八、v4 结论 —— 审批链路打通；v3 的推断是错的

### 纠正 v3

v3 推断「审批瀑布在 preset 的 isolate realm 内分发，外部插件进不去」——**这是错的**。

`standard/agent.cordis.yml` 自己的注释就写明了（第 7-9 行）：

> The host composition (`base.cordis.yml` + `web.cordis.yml`) keeps everything a
> preset must not own: the registries themselves, **the sandbox and approval
> stack**, persistence, and the model route.

审批栈在**宿主平面**，服务向下可见。realm 根本不是原因。

v3 真正的问题是：**模型根本没有发起提权**。它跑完命令、拿到沙箱拒绝，
然后「叙述」了一段自己申请过提权、被取消的经过 —— 而会话投影里
`danger-full-access` 出现 **0 次**。在指令里强制它使用
`sandbox_permissions="danger-full-access"` 重试之后，审批请求立刻正常到达。

> 教训：**不要把模型的叙述当成事实**。要以状态文件 / 事件流 / API 返回为准。
> 前面三轮都被这段叙述带偏了。

### 真正需要的修复（三处）

1. **关掉 `ui-approval`** —— 它接管 waterfall 后会一直等浏览器点击、永不返回，
   后面的应答者根本没机会跑（这是「卡死」的元凶）
2. **监听器注册在 `setup(agentCtx, agent)` 的 `agentCtx` 上** ——
   create 返回后再往 `agent.ctx` 注册是收不到的
3. `approval/request` 的卡片应答实现（已在本插件里）

### 已验证：无人应答分支（端到端）

| 环节 | 证据 |
|---|---|
| 请求到达插件 | `approvalRequest`（tool=`pwsh` + reason） |
| 卡片送达飞书 | `approvalAsked` + 飞书收到 `msg_type: "interactive"` |
| 超时处理 | `approvalTimedOut: "ap-1-2849533f"` |
| **fail-closed** | `approvalOutcome: "unavailable"` |
| **不卡死** | `lastAgentStatus: "idle"`，回合正常结束并回复 679 字符 |
| **未越权** | 工作区外文件未被创建 |

### 待验证：点击分支

`card.action.trigger` → `onCardAction` → 结算 `allowed-once` → 工具带全权限重试
→ 文件创建 → 卡片更新为绿色。

**外部依赖**：飞书开放平台「应用 → 事件与回调 → 回调配置」必须开启。
官方文档明确警告：**没开的话消费者照样启动成功，但没有预检，事件永远不来**。
这是该链路唯一的外部前置条件。

## 九、v5 最终验证（2026-09-30 15:00）—— 目标达成

### 加了文本兜底

卡片按钮依赖飞书回调配置。为了不让这个外部开关卡死整个能力，在
`onMessage` 里加了一条**文本兜底**：该会话若有挂起的审批，回复
「允许 / 同意 / 批准 / yes / ok」或「拒绝 / 不行 / no」即视为决定。
这条走的是**已经验证可用**的消息通道。审批卡片旁边会同时发一条文本说明兜底方式。

### 端到端验证记录

| 环节 | 证据 |
|---|---|
| 用户回复「允许」 | `lastMessage.text = "允许"`，15:00:15 |
| 文本兜底结算 | `approvalViaText` |
| **审批通过** | `approvalOutcome: "allowed-once"` |
| 工具提权重试 | agent 报告第 2 次执行 `danger-full-access` 成功 |
| **越权仅此一次** | `E:\approval-test.txt` 被创建，16 字节，`hello`，15:00:17 |
| 回合正常结束 | `lastAgentStatus: "idle"`，`replyFlush: true`，476 字符回复 |
| 无错误 | `lastError` 为空 |

完整的闭环：

```
飞书消息 → DSH agent 会话（独立持久）
  → 工具调用 → 沙箱拒绝
  → approval/request → 飞书卡片 + 文本提示
  → 用户回复「允许」 → allowed-once
  → 工具带 danger-full-access 重试 → 文件创建
  → agent 回复飞书
```

### 唯一未执行的代码路径

`onCardAction`（卡片按钮点击 → `card.action.trigger`）**从未被触发过**，
因为 `card.action.trigger` 消费者 `received: 0` —— 开放平台的
「事件与回调 → 回调配置」没开。代码已实现并做了白名单校验，启用该配置后即可生效。

### 最终状态

- 插件：[index.mjs](index.mjs)，约 900 行，零外部依赖
- Profile：`feishu`，端口 19388，`ui-approval` 已禁用
- **当前运行的 web profile 全程未改动**

## 十、独立代码审查（2026-09-30）—— 两个严重缺陷

由独立 subagent 通读全部代码 + 实测核对 `lark-cli` 调用面 + 交叉验证
cordis / dsh-agent / dsh-session / dsh-user-approval / dsh-agent-presets /
dsh-agent-loop / dsh-session-persistence 的 `.d.ts` 与实现，产出了
**2 严重 / 9 中等 / 11 轻微**。

### S1（严重）两条消息重叠时，前一条回复被永久丢弃

**根因**：`touchStream()` 在消息**到达时**就清空 `st.text`；而 `flushReply()`
只在 `agent/status === 'idle'` 执行。但 `dsh-agent-loop` 的 `kick()` 是
`while (await this.turn())` —— **整批排队消息共用一个 running 阶段，只会发一次
idle**。于是 msg2 到达时清掉 msg1 的答案，用户只收到最后一条的回复，
前一条答案**彻底消失且无任何日志**。真实聊天里连发两句即触发；
此前所有验证只发单条消息，所以从未暴露。

**修法**：串行化。槽位加 `busy` + `queue`：
- 忙时新消息只入队，**不重置槽位、不 followup**；
- `idle` 时先 `flushReply`，再 `drainQueue` 取下一条执行。

### S2（严重）并发竞态 → agent 泄漏 + 绑定被静默切走

**根因**：`bound` 只在 `create` **全部完成后**才 `set`。两条消息几乎同时到达时，
两个 `onMessage` 都看到「无绑定」→ 用同一 sessionId 各 `create` 一次；
输的一方 `resume`（session 已被赢家占用）失败 → 落入「随机新会话」分支 →
**覆盖绑定**，而赢家那个 handle 从此无人 dispose（**agent + 会话双泄漏**）。
这恰好是会话第一条消息的场景。

**修法**：① 加 `inflight`（chat_id → Promise）做同 chat 去重；
② 覆盖绑定前先 dispose 旧 handle；③ 把 `createError` 改名 `createNote`
（持久会话已存在时 create 失败是**正常路径**，不是错误）；
④ 第三分支包 try/catch 并把失败回一句到飞书，不再静默失败。

### 已修的中等问题

| 编号 | 问题 | 修法 |
|---|---|---|
| M1 | 迟到的卡片点击会把卡片刷成「✅ 已允许一次」，而实际是 fail-closed | settle 返回 false 时改显「⌛ 审批已失效」 |
| M2 | dispose 后挂起的审批定时器不清理 | cleanup 里全部 `resolve('cancelled')` |
| M3 | dispose 后仍会建 agent；selfTest 定时器不清理 | 两个回调加 `disposing` 守卫；定时器存变量并 clear |
| M4 | 轮次失败/空文本 → 飞书侧完全沉默 | `agent/error` 记入槽位；`flushReply` 回一句错误或「本轮无文本输出」 |
| M5 | 文本兜底吞掉正常消息（`ok`/`y`/`可以` 被当批准），多笔挂起无法区分 | **必须带审批 id**（`允许 ap-3-ab12`）；仅当唯一一笔挂起时才接受简写；移除 `ok/y/n/可以` |
| M7 | 未授权者仍会收到回复；群聊过滤在白名单之后 | 顺序调整；未授权**不回消息**，只 warn + 记状态 |
| L1 | 逐块 `toString('utf8')` 会把被 chunk 切开的中文变成 U+FFFD | 改 `setEncoding('utf8')` |
| L2 | 长回复超 Windows 命令行上限（≈32767）→ 静默丢失 | 按 ~2500 字符切片顺序发送 |
| L3/L4 | `consumers` 只增不减；两个 consumer 共用一个 `restartTimer` | 前一轮已改 `Set` |
| L5 | 正常重启会把 `createError` 永久写进状态文件误导排障 | 改名 `createNote` |
| L6 | `consumerPid` 只反映最后一个消费者 | 改为 `consumerPid_${label}` |
| L9 | `loadLlmFactory` 每条消息重试一次必然失败的 import | 失败一次后置标志 |
| L12 | 本文档把结果词汇写成 `denied`（代码是对的） | 已改 `rejected` |

### 审查确认「正确」的部分（避免以后误改）

- Cordis Proxy/`inject`、`ctx.logger` 无需 inject
- scope-filtered 事件注册在 `setup(agentCtx)` 上 —— 与
  `dsh-user-approval` 的 `scopeTarget(req.agent, req.agent)` 分发域一致
- 所有事件 payload 字段名与 `.d.ts` 逐一对齐
- 回复正文取已提交的 `assistant/message`（避开 text-delta 里的工具调用标记）
- spawn 时删 `HERMES_HOME`
- lark-cli 调用面（`+messages-reply` / `+messages-send --msg-type interactive` /
  `api POST /open-apis/interactive/v1/card/update`）与官方参考一致
- `settle()` 幂等：重复点击、迟到点击不会二次 resolve
- 审批结果词汇与 `ApprovalOutcome` 逐字一致
- `prepend: true` 是合法选项（`cordis/lib/types/events.d.ts`）
- abort → cancelled 边界安全：`decide()` 在派发 waterfall **之前**就处理
  `signal.aborted`，请求根本进不到本插件；且有 race 保证 agent 不被挂起 promise 卡住
- 所有回调都有 try/catch，**没有会冒泡到宿主的异常路径**
- 无 shell 注入（`spawn` 不带 `shell`，用 `.exe`）

### 第二轮修复：M6 / M8 / M10（2026-10-07）

**M6｜群聊未校验 @ 提及** —— 已修

原来只判 `chat_type`：开关一开，群里任何白名单用户的消息都会驱动 agent
并把回复发进群。现在：

- 新增配置 `botOpenId`；留空则启动时通过
  `lark-cli api GET /open-apis/bot/v3/info` 自动解析（实测返回
  `data.open_id`）；
- 群聊消息必须 `mentions[].id === botOpenId` 才响应；
- **拿不到 `botOpenId` 时一律拒绝群消息**（fail-closed），不会退化成「放行」。

**M8｜缺事件去重** —— 已修

飞书会重投事件，长连接每 10 秒还会重连一次；没有去重时同一条消息会被喂给
agent 两次（工具重复执行、回复重复发送）。

- 新增有界 LRU `seenIds`（默认 500，配置项 `dedupWindow`）；
- 消息按 `message_id` 去重；
- 卡片按 `event_id` 去重 —— **不能用 `message_id`**，同一张卡片的不同点击
  共用它，那样会把正常点击也丢掉；
- 自测注入改用随机 `message_id`，否则会被自己的去重挡掉。

**M10｜`prepend` 压掉同进程其他审批应答者** —— 已修（改为显式可配）

`prepend` 本身是合法用法，问题在于**语义没被显式表达**：本应答者一旦接管就会
一直等到 `approvalTimeoutMs`，排在其后的应答者（如 web UI 的 `ui-approval`）
根本没机会执行。

- 新增配置 `answerApprovals`（默认 `true`）：设为 `false` 时**完全不注册**
  应答者，审批交给同 profile 的其他应答者；
- 启动时打印审批归属，避免「两个应答者互相指望」这种静默故障；
- README 与配置模板都写明了这个前置条件。

> 注意：本插件的应答者注册在**各自 agent 自己的 scope**（`agentCtx`）上，
> 所以它只可能影响**本通道创建的 agent**，不会干扰浏览器里你自己的会话。
> 真正的风险是「你在浏览器前，却指望通道 agent 的审批弹在浏览器里」。

### 仍未修（记录在案，非阻塞）

- **L8**：状态文件同步 I/O 在事件热路径上
- **L10**：非文本消息被丢弃（虽然飞书已把 `content` 预渲染成文本）
- **L11**：会话 id 用 chatId 前 24 字符派生，理论碰撞






