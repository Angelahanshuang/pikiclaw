翻译自CLAUDE.md

一个分层的、开放的 Agent 协调器。不是 “编码 Agent 的 IM 桥梁”——IM 是几个可插拔终端之一。
四层 (顶层→底层):
1. 终端——IM 通道和 Web Dashboard 都是可插入的入口点。
2. Agent——通过驱动程序注册表包装同类最佳代理 (Claude Code、Codex、Gemini、Hermes);ACP 兼容的代理通过相同的合同插入。
3. 模型——跨边界模型 (Claude、GPT/Codex、Gemini)、国产中文系列 (DeepSeek、豆包、MiMo、MiniMax)、OpenRouter 和任何 OpenAI 兼容的代理的路由。Providers + Profiles Vault 在生成时为每个代理注入凭证。
4. 工具——skills、MCP 服务器、CLI 工具，跨全局/工作区范围合并。
编排器就是产品。以分层框架为主导。

## 项目结构

src/
  core/                        零业务逻辑基础架构
    constants.ts               集中超时、重试、数值常量（单一来源）
    logging.ts                 分级作用域日志输出 + 带保留策略的日志文件写入器
    platform.ts                跨平台 OS 原语（IS_WIN、home 展开、which、路径处理）
    process-control.ts         daemon PID 文件、进程树终止、重启协调、restart 状态文件
    utils.ts                   纯工具函数（环境变量解析、格式化、Promise 超时回退等）
    version.ts                 从 package.json 读取并导出包版本
    git.ts                     git status 解析（分支/前后落后/变更分类）+ 一行摘要
    turn-audit.ts              每轮对话终态 JSONL 审计日志（含轮换策略）
    legacy-compat.ts           PIKICLAW_* 环境变量与 ~/.pikiclaw 目录向 pikiloom 迁移
    config/
      user-config.ts           ~/.pikiloom/setting.json 加载/保存/同步/变更监听
      runtime-config.ts        运行时 agent/model/effort/workflow 解析（config→env→默认值）
      validation.ts            七个 IM 渠道凭据的在线/离线校验
    secrets/
      store.ts                 系统钥匙串封装（读/写/删，旧条目回迁）
      resolver.ts              CredentialRef 四种来源的凭据明文解析
      ref.ts                   CredentialRef 类型定义 + 类型守卫
      inline-seal.ts           内联凭据 AES-256-GCM 加密封装
      index.ts                 secrets 模块出口（persistSecret/forgetSecret 高层封装）

  catalog/                     扩展页面的纯数据清单（无业务逻辑）
    mcp-servers.ts             推荐 MCP 服务器清单
    cli-tools.ts               推荐 CLI 工具清单
    skill-repos.ts             推荐技能仓库清单
    local-models.ts            本地可运行模型清单（Ollama/MLX）
    index.ts                   catalog 聚合出口

  model/                       模型路由层
    types.ts                   模型层数据类型（Provider/Profile/目录）
    validation.ts              Provider 凭证有效性校验（探测 /models 端点）
    provider-models.ts         Provider 模型列表内存缓存（30min TTL）
    store.ts                   模型配置持久化 CRUD（setting.json models 段 + keychain）
    catalog.ts                 models.dev 模型目录拉取（24h 磁盘缓存）
    responses-bridge.ts        OpenAI Responses→Chat Completions 本地 HTTP 桥（Codex 用）
    anthropic-bridge.ts        Anthropic→Chat Completions 本地 HTTP 桥（Claude Code 接国产模型）
    injector.ts                按 Agent 生成 spawn 环境变量/argv 的 BYOK 注入器
    index.ts                   模型层统一出口

  agent/                       Agent 抽象层
    driver.ts                  AgentDriver 接口 + 可插拔驱动注册表
    types.ts                   agent 层共享类型定义
    stream.ts                  CLI spawn 框架 + 流式编排主流程
    session.ts                 会话工作区 CRUD（.pikiloom/sessions 索引/运行态/导出导入）
    skills.ts                  项目 skill 发现（.pikiloom/skills / SKILL.md frontmatter 解析）
    skill-installer.ts         包装 npx skills add 安装/卸载 + ledger 账本
    auto-update.ts             后台 agent CLI 版本检查与更新（幂等安装闸门）
    index.ts                   agent 层统一出口
    utils.ts                   纯工具函数集合
    handover.ts                跨 agent 会话交接（按目标上下文窗口压缩为 seed prompt）
    kernel-bridge.ts           内核（@pikiloom/kernel）与 legacy 驱动切换开关
    images.ts                  图片附件处理（base64 inline / file:// 白名单校验）
    goal.ts                    会话目标持久化（goal.json：预算/暂停/恢复/续跑）
    accounts.ts                多账户存储（claude token 账户增删切换，凭据入 vault）
    artifacts.ts               交付文件管理（im_send_file staging 与 delivered 清单）
    acp-client.ts              ACP 协议 JSON-RPC 客户端（spawn ACP 子进程）
    npm.ts                     agent 的 npm 包名 / brew cask / 安装命令静态映射
    turn-snapshot.ts           已交付回合持久化快照（sidecar jsonl，弥补 CLI jsonl 丢轮次）
    await-resume.ts            awaiting.json 标记文件读写（等待后台任务状态）
    drivers/
      claude.ts                Claude Code 驱动（spawn CLI，stream-json 输出）
      claude-tui.ts            Claude TUI 驱动（node-pty 完整交互终端）
      codex.ts                 Codex 驱动（app-server JSON-RPC + CLI 双路径）
      gemini.ts                Gemini CLI 驱动
      hermes.ts                Hermes 驱动（走 ACP 协议）
    cli/
      detector.ts              外部 CLI 探测（二进制/版本/认证状态，TTL 缓存）
      auth.ts                  CLI 认证会话管理（spawn login/apply token/logout）
      catalog.ts               组合 registry + detector 生成 CLI 目录项
      registry.ts              推荐 CLI 清单访问函数
      index.ts                 cli 模块统一出口
    mcp/
      bridge.ts                per-stream MCP 桥编排（注入 session MCP server）
      session-server.ts        给 agent CLI 使用的 stdio MCP server 入口
      registry.ts              推荐 MCP server / skill repo 目录访问
      extensions.ts            MCP 扩展 CRUD + 会话合并 + 健康检查 + OAuth 头注入
      oauth.ts                 MCP OAuth 2.1 + 动态客户端注册（PKCE 流程）
      capabilities.ts          会话工具能力定义（工具组 + 提示词绑定）
      tools/
        workspace.ts           im_list_files / im_send_file / im_update_memory 工具
        ask-user.ts            im_ask_user 工具（阻塞等用户回复）
        await-resume.ts        await_background 工具
        goal.ts                goal_get / goal_update 工具
        feishu-user.ts         feishu_send_message / feishu_read_doc 工具（以用户身份）
        types.ts               MCP 工具模块公共类型与辅助函数

  bot/                         与渠道无关的机器人运行时
    bot.ts                     Bot 基类：共享状态、runStream()、会话/偏好等全部公共 API
    commands.ts                命令数据装配（getStartData/会话/agents/models/status 快照）
    command-ui.ts              命令选择式 UI（按钮/列表）模型 + 动作执行器
    orchestration.ts           菜单状态、任务 ID、knownChat 环境变量、消息↔会话注册表
    human-loop.ts              人机交互状态机（Codex im_ask_user + Dashboard 共用）
    streaming.ts               流式渲染辅助（shell 活动摘要、提示词剥离、预览 meta）
    render-shared.ts           跨渠道共享渲染片段（footer、GFM 表格、图片分发）
    menu.ts                    默认菜单命令构建（sk_ 前缀 skill 命令索引）+ 欢迎语
    host.ts                    宿主机电池/CPU/内存读取（/host 命令）
    session-hub.ts             会话查询中枢与批量操作（更新/删除/迁移/导入导出）
    session-status.ts          会话状态计算（current/running/stale 30min 判定）
    queue-steer.ts             steer 时待延迟的排队任务 ID 计算
    headless-bot.ts            无 IM 渠道时给 Dashboard 使用的最小 Bot 子类

  channels/                    物理隔离的 IM 实现（每个渠道 channel.ts + bot.ts + render.ts）
    base.ts                    抽象 Channel 基类 + 能力标志 + 共享工具
    states.ts                  渠道配置状态是否可缓存判断
    health.ts                  渠道连接健康跟踪（指数退避重试/告警）
    telegram/                  自实现 HTTP long-polling 传输（channel.ts）、TelegramBot（bot.ts）、HTML 渲染（render.ts）、流式实时预览（live-preview.ts）、目录浏览键盘（directory.ts）
    feishu/                    基于 lark node-sdk WebSocket 传输（channel.ts）、FeishuBot（bot.ts）、交互卡片渲染（render.ts）、GFM markdown 适配（markdown.ts）
    weixin/                    微信 ilinkai 长轮询传输（channel.ts）、WeixinBot（bot.ts）、ilinkai API 与 QR 登录（api.ts）
    wecom/                     企业微信 WebSocket + 心跳回执传输（channel.ts）、WeComBot（bot.ts）
    slack/                     基于 socket-mode 传输（channel.ts）、SlackBot（bot.ts）
    discord/                   基于 discord.js Gateway 传输（channel.ts）、DiscordBot（bot.ts）
    dingtalk/                  基于 dingtalk-stream 传输（channel.ts）、DingtalkBot（bot.ts）

  dashboard/                   Hono HTTP server + React SPA
    server.ts                 Hono 服务器装配（路由/静态资源/WebSocket/端口重试）
    runtime.ts                全局单例 Runtime（Bot 引用、运行时偏好、事件广播）
    platform.ts               平台权限检测（屏幕录制/完全磁盘访问/宿主终端）
    session-control.ts        Dashboard→Bot 桥接（任务队列/交接 handover/交互提问）
    routes/
      config.ts               /api/state、配置保存、渠道校验、微信扫码、进程重启等
      agents.ts               agent 安装/更新/运行时偏好路由
      sessions.ts             会话列表/tail/workspaces/session-hub 系列/附件下载
      extensions.ts           MCP server 与 skills 的 catalog/install/OAuth 路由
      cli.ts                  外部 CLI catalog/认证/安装路由
      accounts.ts             多账号列表/增删/切换激活
      models.ts               Provider/Profile CRUD 与 agent 绑定
      local-models.ts         本地模型探测（Ollama/mlx-lm 后端）

  cli/                         CLI 启动入口
    main.ts                   --daemon / --no-daemon / --setup / stop 主入口 + daemon 看门狗
    run.ts                    单次命令工具（status/models/sessions/tail/单轮流式运行）
    channels.ts               渠道解析纯工具（resolveConfiguredChannels）
    setup-wizard.ts           交互式设置向导（目前仅 Telegram）
    onboarding.ts             设置状态数据模型与文本指南
    channel-supervisor.ts     渠道 Bot 启停/替换（凭据快照对比）+ HeadlessBot 降级
    autostart.ts              macOS 登录自启（LaunchAgent plist + launchctl）
    kernel-app.ts             新内核（@pikiloom/kernel）后端引导（LOOM_KERNEL_APP=1 门控）

  pikichannel/                 远程控制协议通道（移动端/Dashboard 连接用）
    protocol.ts               统一线协议 + 快照 diff / apply 增量补丁算法
    codec.ts                  消息 JSON 编解码
    code.ts                   连接码编码（base64url）/ direct / remote / none 三模式
    host.ts                   PikichannelHost 核心（连接/认证/订阅/diff 广播）
    server.ts                 pikichannel 装配入口（token/三传输/路由/QR）
    turn.ts                   Cloudflare TURN/ICE 凭据解析与动态生成
    transport.ts              传输抽象（ChannelConnection / ChannelTransport）
    adapter-pikiloom.ts       把 Bot 流快照投影为 UniversalSnapshot 的适配器
    rendezvous-host.ts        host 端连接外部 rendezvous broker（WebRTC 拨号）
    rendezvous-broker.ts      内置拨号/信令中转服务
    transports/
      websocket-host.ts       WebSocket 传输（keepalive ping）
      webrtc-host.ts          WebRTC 传输（信令 → DataChannel）
      webrtc-shared.ts        werift answerer 共享实现 + ICE 服务器装配

  browser-profile.ts          托管浏览器 profile 目录/启动参数/CDP 端点管理
  browser-supervisor.ts       托管浏览器进程级单例（probe/ensure/restart/invalidate）

## 分层依赖关系
进口严格向下流动——没有来自上一层的进口：

cli/  →  dashboard/  →  channels/*  →  bot/  →  agent/  →  catalog/, core/

## 架构设计：为什么这样设计

### 整体命题

核心命题是**"编排器即产品"**：每一层都是可插拔的，目录划分不是按功能模块，而是按"抽象层级 + 演进边界"。四层架构映射到目录：

```
 终端层   cli/ dashboard/ channels/ pikichannel/   ← 入口可插拔
  Agent层  agent/                                  ← 驱动可插拔
  模型层   model/                                  ← 模型/Provider 可插拔
  工具层   catalog/ + agent/mcp/ + agent/skills    ← 扩展可插拔
 ──────────────────────────────────────────────
  地基     core/（零业务逻辑，被所有层依赖）
```

### 为什么严格单向依赖

`cli → dashboard → channels → bot → agent → catalog, core`，用约束换取三件事：

- **可测试性**：`core/` 零业务逻辑，任何改动不影响上层；基础设施正确性可单独验证。
- **防循环依赖**：agent 不 import 渠道、渠道不 import agent 具体实现，只有 `bot/` 这一个"胶水层"知道双方如何协作。
- **演进安全**：新增一个 IM 渠道时，`bot/` 的会话/流式逻辑一行不用动。

### bot/ 与 channels/ 的分离（最关键的一个决策）

7 个渠道的 `bot.ts` 命令处理结构高度同构（`cmdStart`/`cmdStatus`/`cmdSessions`…），却刻意不合并：

- `bot/` 管"会话状态机 + 流式编排"——所有渠道共享的**大脑**，实现一次。
- `channels/` 管"字节级传输 + 平台渲染"——每个平台的**手脚**，物理隔离成独立目录。

这是**以少量代码重复换取故障隔离**：飞书 WebSocket 挂了不会拖垮 Telegram 的 long-polling；改飞书卡片渲染不需要担心破坏 Slack 的 thread 逻辑。隔离优先于 DRY，因为渠道 SDK 依赖互斥、生命周期独立。

### agent/ 层的三件套

- **Driver 注册表**：claude/codex/gemini/hermes 输出格式完全不同（stream-json / JSON-RPC / ACP）。`driver.ts` 定义统一契约 `AgentDriver` 抹平差异，注册表即 `Map<string, AgentDriver>`。类比 USB 集线器 + 转接头。
- **stream 框架**：`stream.ts` 不关心具体 agent，只编排每轮公共生命周期（准备 prompt → 落会话记录 → 调 driver/kernel → 补全 result → 返回）。
- **MCP 工具注入**：agent CLI 不认识 orchestrator，但都原生认识 MCP 协议。`bridge.ts` 为每个会话动态生成 session-scoped MCP server（`session-server.ts`），通过 `codex mcp add` / gemini settings / claude mcp-config.json 塞进 agent，暴露 `im_ask_user`、`im_send_file` 等工具。

### model/ 独立成层：解决"壳与核"的错配

Claude Code 只懂 Anthropic 协议，但模型层要路由到 DeepSeek/豆包等 Chat Completions 提供商——所以有 `anthropic-bridge.ts`（Anthropic→Chat Completions 本地 HTTP 桥）、`responses-bridge.ts`（OpenAI Responses→Chat Completions）。模型层独立，才允许为不同 agent 做不同的协议翻译，而不是把翻译逻辑塞进每个 driver。

### core/secrets/：安全边界

密钥管理（keychain + 内联 AES-GCM + env 回退）集中在最底层。任何上层拿到的都只是 `CredentialRef`，实际明文只在 spawn 那一瞬间由 `model/injector.ts` 解析——安全边界不散落在业务层。

### pikichannel/：终端层的一种特殊形态

它不是 IM，而是自定义协议终端：WebSocket/WebRTC/rendezvous 三种传输 + 快照 diff 增量协议，目的是异地远程控制（手机控制本地 runtime）。它复用 `dashboard/runtime` 的快照，却走完全独立的传输栈——再次印证"终端可插拔"：将来加原生客户端不需要动 `bot/`。

### 根目录单例为什么"无家可归"

`browser-profile.ts` 与 `browser-supervisor.ts` 放 `src/` 根，因为托管浏览器是**进程级单例**（dashboard、agent、MCP 三方共用）。放任何一层都会引发"谁拥有它"的归属争议，放根是刻意的：**共享单例不归任何业务层所有**。

### 设计成本（可批判点）

- `channels/` 物理隔离 → 7 份同构代码，新增渠道要复制整个模板（换故障隔离的税）。
- `agent/mcp/` 的工具注入强依赖 MCP——agent 不支持 MCP 时没有注入通道。
- `cli/kernel-app.ts` + `agent/kernel-bridge.ts` 是双轨制（`@pikiloom/kernel` 与 legacy 并存），说明架构正处内核迁移过渡期。

## 双轨内核：@pikiloom/kernel 与 legacy 并存

### 并存的事实

跑一轮 agent 的入口在 `agent/stream.ts` 的 `doStream`：

```ts
if (shouldUseKernelPipeline(prepared.agent)) {
  result = await kernelStream(prepared);          // 新：走 @pikiloom/kernel
} else {
  result = await driver.doStream(prepared);       // 旧：走项目自带的 legacy driver
}
```

- **legacy 管线**：项目原本的实现。`agent/drivers/*.ts` 5 个 driver，每个自己 spawn CLI、自己解析输出格式。
- **kernel 管线**：独立包 `@pikiloom/kernel`（`packages/kernel`）。有自己的 Driver 注册表（`ClaudeDriver`/`CodexDriver`/`AcpDriver`/`EchoDriver`…）、`runTurn` 和 `WebSurface`。`kernel-bridge.ts` 把 pikiloom 的 `StreamOpts` 翻译成 kernel 的 `AgentTurnInput`，再把 kernel 的 `UniversalSnapshot` 翻译回 pikiloom 的预览/结果格式。

### 逃生通道（agent/kernel-bridge.ts 的 shouldUseKernelPipeline）

| 开关 | 效果 |
|------|------|
| 默认（无开关） | 走 kernel |
| `LOOM_KERNEL_PIPELINE=0` | 强制 legacy |
| `~/.pikiloom/dev/kernel-legacy.on` 文件 | 不重启、热切回 legacy |
| `LOOM_KERNEL_PIPELINE=1` | 强制 kernel（压过文件） |
| 测试环境（VITEST） | 永远走 legacy（单测断言 legacy 行为） |
| kernel 加载失败（缺 dist） | 自动回退 legacy |

### 为什么不能直接砍掉一套

1. **灰度回退**：新内核未被充分验证前，线上必须有一条一键回退的路。legacy 是安全网，不是死代码。
2. **职责边界还没画完**：application-level parity 是 pikiloom 产品层逻辑、kernel 不该内置——claude 的 jsonl 会话入口重写、codex 的 provider 报错人性化、plan 字段 `{text}`→`{step}` 翻译，都由 bridge 在接缝处补齐。
3. **还有第二层并存**：`cli/kernel-app.ts` 是整机级的新版启动（`LOOM_KERNEL_APP=1`），整个后端跑在 kernel 的 `createLoom()` 上；默认 `npm run dev` 仍是旧整机（`cli/main.ts`）。即"轮次级 + 整机级"双层的双轨。

一句话：**kernel 是下一代运行时，legacy 是当前主力；二者由 `kernel-bridge.ts` 这个切面并存，kernel 负责把轮次跑起来，bridge 负责把结果翻译回 pikiloom 的世界。**

## 核心链路：Driver 注册表 / stream 框架 / MCP 工具注入

### 核心困境

pikiloom 要指挥 4 个"不认它"的外部程序：claude / codex / gemini / hermes 都是独立进程、独立输出格式、不认识 pikiloom。由此拆出三个子问题。

### 子问题 A：输出格式五花八门，怎么统一？→ Driver 接口（USB 类比）

claude 输出 stream-json 流、codex 走 `app-server` JSON-RPC、gemini 输出 stream-json、hermes 走 ACP 协议。`driver.ts` 定义统一契约：

```ts
interface AgentDriver {
  id: string; cmd: string;
  doStream(opts: StreamOpts): Promise<StreamResult>;   // 跑一轮
  getSessions(...); getSessionTail(...); listModels(...); getUsage(...);
}
```

每个 agent 写一个类，把自家 CLI 的怪格式在 driver 内部消化掉，对外只输出统一形状。注册表即 `Map<string, AgentDriver>`。类比：**USB 集线器 + 转接头**——上游只认 USB 口。

### 子问题 B：stream.ts 负责什么？→ 一轮的完整生命周期编排

`doStream` 不管具体 agent，只管"无论哪个 agent，这轮都得走这些步骤"：

```
准备 prompt（剥离系统注入）→ 落会话记录 → 检查 fork/更新 → 调 driver 或 kernel
→ 收 StreamResult → 补全（用量字段、plan 翻译、错误格式化、session 落盘）→ 返回
```

**`stream.ts` 是唯一知道"这轮走 kernel 还是 legacy"的地方**，driver 只做"spawn + 解析"这一件事。

### 子问题 C：agent 不认识 pikiloom，怎么给它塞工具？→ MCP 桥 + HTTP 回调

核心矛盾：**pikiloom 想让 agent 拥有"列文件、发文件、问用户问题"的能力，但 agent 进程根本不知道 pikiloom 存在。**

1. **借 MCP 协议**：agent 不认识 pikiloom，但都原生认识 MCP。会话启动时动态生成会话专属 MCP server 配置，让 agent 启动时带上。
2. **这个 MCP server 就是 pikiloom 自己**：`session-server.ts` 是本机 stdio MCP server，暴露 `im_list_files` / `im_send_file` / `im_ask_user` / `goal_get`。对 agent 而言它只是"一个 MCP server"，另一端是 pikiloom 的世界。
3. **不同 agent 用不同姿势塞进去**（agent/mcp/bridge.ts）：
   - codex → 执行 `codex mcp add <name>` 注册
   - gemini → 写 `gemini-system-settings.json`
   - claude → 写 `mcp-config.json`
   
   同时注入环境变量：`PIKILOOM_MCP_SERVER`、`MCP_WORKDIR`、`MCP_STAGED_FILES`，以及关键的 **`MCP_CALLBACK_URL=http://127.0.0.1:<随机端口>`**。

**为什么还需要 callbackUrl？** 因为 `im_ask_user` 是阻塞式人机交互：agent 调用后挂起等人回话，但 agent 拿不到 IM 渠道。pikiloom 通过回调 URL 把问题推到 IM（飞书/Telegram），用户回复后再唤醒 agent——配套的 `bot/human-loop.ts` 就是这套交互的状态机。MCP 协议本身不支持这种异步交互，所以用 HTTP 回调补上。

### 三个子问题的关系图

```
         bot/（渠道无关）
           │  StreamOpts（统一形状）
           ▼
   agent/stream.ts  ← 轮次编排 + 分流接缝（kernel / legacy）
           │
   ┌───────┴────────┐
   ▼                ▼
kernel-bridge     driver.doStream()        ← 子问题B：谁跑
   │                │
   ▼                ▼
@kernel/runTurn   drivers/*.ts（转接头）     ← 子问题A：统一格式
                          │
                          ▼
                   spawn claude/codex/...（黑盒 CLI）
                          ▲
                          │ 启动时读取生成的 MCP 配置
                          │（codex mcp add / gemini settings / mcp-config.json）
        agent/mcp/session-server.ts（pikiloom 伪装的 MCP server）← 子问题C：注入工具
                          │ 工具回调
                          ▼
                 callbackUrl → IM 渠道 → human-loop（问用户/发文件）
```

一句话总结：**Driver 接口解决"格式不统一"，stream 框架解决"每轮公共步骤不重复"，MCP 桥解决"外部 agent 进程如何获得 pikiloom 的能力"——三者合起来让 pikiloom 能以一套代码指挥四个陌生程序。**

## 关键概念
bot/bot.ts          拥有共享的运行时状态和 runStream()
agent/stream.ts     是 CLI 的生成框架; agent/driver.ts 保持代理可插拔
agent/mcp/bridge.ts 为每个 stream 注入会话范围的 MCP 工具; agent/mcp/extensions.ts 合并全局 + 工作空间 MCP 配置并解析 OAuth 承载
bot/human-loop.ts   是 Codex 用户输入和 im_ask_user MCP 工具的单一状态机。
browser-supervisor.ts 是托管 Chrome 的进程级单例——流调用 care()，永远不会直接重启
通道中的每个通道都是物理隔离的——触摸Telegram永远不需要触摸Feishu代码

## Quick Reference
| Task | Files to read |
|------|---------------|
| 添加代理驱动程序 | `agent/driver.ts`, any `agent/drivers/*.ts` as example |
| 添加推荐 MCP / CLI /技能 | `catalog/{mcp-servers,cli-tools,skill-repos}.ts` |
| 会话管理 |`agent/session.ts`,`agent/types.ts`|
| 流stream的行为 | `agent/stream.ts`, `bot/bot.ts` (`runStream`) |
| Add a Telegram command | `channels/telegram/bot.ts`, `bot/commands.ts` |
| Feishu rendering | `channels/feishu/render.ts`, `bot/render-shared.ts` |
| 仪表板 API route |`dashboard/routes/*.ts`,`dashboard/runtime.ts`|
| MCP 工具行为 |`agent/mcp/tools/*.ts`,`agent/mcp/bridge.ts`|
| MCP extension CRUD / OAuth | `agent/mcp/extensions.ts`, `agent/mcp/oauth.ts` |
| 外部 CLI 检测 /授权 | `agent/cli/detector.ts`, `agent/cli/auth.ts` |
| 用户配置模式 | `core/config/user-config.ts` |
| 跨平台操作系统行为 | `core/platform.ts` |
| 管理的浏览器生命周期管理 | `browser-supervisor.ts`, `browser-profile.ts` |
