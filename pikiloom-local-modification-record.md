# Pikiloom Agent 底层框架改造记录

**时间**: 2026-08-06
**参与者**: 用户 (User) & 智能助手 (Agent)
**项目**: 赛事Agent Team PoC (`pikiloom-local`)

## 核心痛点与需求背景
团队在使用 `pikiloom` 框架与飞书结合的过程中，暴露出了以下 5 个核心痛点：
1. **上下文冗余与成本失控**：飞书会话不切换，历史 Token 越积越多。
2. **读写冲突与群聊混乱**：所有员工共用 Workspace 导致文件覆盖；群聊中多人 `@Agent` 导致上下文串线。
3. **失忆与授权繁琐**：Agent 记不住错误指令；飞书文档/多维表格的 OAuth 授权频繁过期；机器人身份与操作人身份混淆。
4. **模型滥用**：出文案等简单任务依然调用昂贵的 Claude Code，造成资源浪费。
5. **生态融合与数据盲区**：Agent 操作飞书不熟练；缺乏针对员工维度的使用量（Token）追踪与成本分摊能力。

## 方案设计与共识
经过讨论，双方确立了从**机制设计**和**业务流**切入的解决方案，并划分为 4 个里程碑推进：

- **Milestone 1: 基础设施与数据层改造**。引入 PostgreSQL，设计 Token 授权表与用量日志表；实现基于 `open_id` 的 Workspace 物理隔离。
- **Milestone 2: 飞书认证保活与会话隔离**。利用 PG `SKIP LOCKED` 机制开发守护进程实现 Token 无感刷新；在飞书群聊中强制启用 `Thread` 模式，实现会话天然隔离与截断。
- **Milestone 3: 长期记忆机制**。借鉴 Trae，在执行上下文中自动注入员工专属的 `user_profile.md` 与 `lessons_learned.md`；开发 `UpdateMemory` 工具，赋予 Agent 动态修改记忆的能力。
- **Milestone 4: 原子工具封装与用量打点**。封装飞书读写工具并强制绑定员工 `UserAccessToken`；在流式输出结束的生命周期钩子中拦截 Token 数据并写入数据库；在消息入口层实现正则意图路由（智能降级为 `codex`）。

## 代码实现与落地细节
随后，Agent 严格遵循“测试驱动、里程碑推进”的原则，对 `pikiloom-local` 源码进行了如下深度改造：

1. **数据库迁移**
   - 创建 `db/migrations/015_agent_auth_and_usage.sql`，定义了 `user_auth_tokens` 和 `agent_usage_logs` 表结构。
2. **Workspace 动态路由**
   - 修改 `bot.ts` 的 `resolveIncomingSession`，提取 `ctx.from.openId`，将执行目录动态映射到 `workspaces/{ou_xxxx}`。
3. **飞书群聊 Thread 隔离**
   - 验证了飞书 `reply_in_thread` 机制。
   - 重构 `base.ts` 与 `channel.ts` 的 `SendOpts` 接口，支持 `replyInThread` 参数。
   - 在 `bot.ts` 中拦截群聊的“首次对话”与“持续对话”，确保 Agent 回复均收敛在独立的话题 Thread 中，杜绝上下文污染。
4. **Token 刷新守护进程**
   - 新建 `src/feishu-auth-worker.js`，通过定时任务加 PG 行级锁，提前刷新过期时间不足 2 小时的飞书授权 Token。
5. **长效记忆机制 (Trae Like)**
   - 在 `bot.ts` 的 `runStream` 构建 System Prompt 环节，自动寻找并读取当前员工 Workspace 下的 `user_profile.md` 和 `lessons_learned.md`，使用 XML 标签注入上下文。
   - 新增 `agent/mcp/tools/workspace.ts` 中的 `im_update_memory` MCP 工具，供大模型主动调用更新记忆。
6. **越权隔离与原子工具**
   - 新建 `agent/mcp/tools/feishu-user.ts`，封装 `feishu_send_message` 和 `feishu_read_doc`。执行时自动根据 Workspace 路径反推 `openId`，并从数据库提取 `UserAccessToken`，实现“员工名义”操作。
7. **用量打点与智能路由**
   - 在 `bot.ts` 的 `handleMessage` 结束逻辑中，将 `inputTokens`、`outputTokens` 异步写入 PG 数据库。
   - 在接收文本前增加意图拦截：识别到“写文案/翻译/总结”等关键词，强制将 Agent 模型切换为 `codex`。
8. **代码审查准备**
   - 所有关键改动节点均补充了 `[中文注释]`。
   - 重新执行 `npm run build`，使所有 TS 源码的改动生效至 `dist` 目录。

## 关键技术解答记录
*   **关于 `ctx.from.openId`**：确认了飞书 `open_id` 的格式（如 `ou_xxxx`），并明确了在单一机器人应用下，它对员工是**绝对唯一且固定**的，适合作为文件系统隔离和数据库外键的基准。
*   **关于 Trae 的记忆机制借鉴**：总结了 Trae 的“分层挂载（全局画像+项目规则）”与“状态固化（Agent 自动调工具写 Markdown）”理念，并指出本次 Phase 3 改造正是对这一优秀机制的完美复刻。

*(文档生成时间：2026-08-06)*

---

## 待定改造计划：飞书话题内 `/命令` 的执行与回应收敛

**记录时间**: 2026-08-08  
**状态**: 待评估，暂不修改代码

### 背景
当前已经完成了飞书群聊中基于 `thread_id` 的话题续聊识别：群里首次 `@bot` 会开启独立话题，后续在该话题中的普通文本回复可以继续命中原 Session，而无需再次 `@bot`。

但用户还可以通过发送 `/` 开头的命令（如 `/models`、`/mode`、`/agents`、`/switch`）来切换模型、切换工作目录或查看配置。需要进一步确认：这些命令在“话题内”触发后，是否也应当**始终在原话题内回应**，而不是回到群主会话。

### 当前调用链梳理
1. 飞书消息进入 `src/channels/feishu/channel.ts` 的 `_handleMessageEvent`。
2. 若解析后的文本以 `/` 开头，则不走普通消息处理，而是直接调用 `_hCommand(cmd, args, ctx)`。
3. `src/channels/feishu/bot.ts` 的 `run()` 中，通过 `this.channel.onCommand((cmd, args, ctx) => this.handleCommand(cmd, args, ctx))` 绑定命令处理入口。
4. `handleCommand()` 再根据命令名分发到 `/models`、`/mode`、`/agents`、`/switch`、`/sessions` 等具体方法。
5. 部分命令通过 `ctx.reply(...)` 回文本；部分命令通过 `sendCommandView(...)` 或 `ctx.channel.sendCard(...)` 直接发卡片。

### 当前行为判断
1. **命令可以在话题里被触发**
   - 由于入站 `ctx` 已携带 `threadId/rootMessageId`，且群话题续聊 gate 已允许 bot 自己创建的话题继续放行，因此在话题里发送 `/models`、`/mode` 等命令，当前实现是可以收到并执行的。
2. **命令回应未完全 thread-aware**
   - 文本型回复虽然会基于当前消息 `replyTo`，但代码里尚未统一显式传入 `replyInThread: true`。
   - 卡片型回复（如模型列表、模式选择、Workspace 卡片）当前很多地方仍直接调用 `sendCard(chatId, ...)`，更偏向“发到 chat”，而不是“留在原话题里”。
3. **因此现状是：命令能执行，但不能保证所有回应都稳定收敛在同一个话题内。**

### 待定改造方案
若后续决定实现“话题内 `/命令` 始终在原话题内回应”，建议按以下方向改造：

1. **统一命令回复语义**
   - 为命令回复新增一层 thread-aware 的发送封装。
   - 当 `ctx.threadId` 存在时：
     - 文本回复统一走 `ctx.reply(..., { replyInThread: true })`
     - 卡片回复统一走基于 `ctx.messageId` 的 `replyCard(..., true)`，而不是 `sendCard(chatId, ...)`
   - 当 `ctx.threadId` 不存在时，保持当前行为不变。

2. **重点改造入口**
   - `sendCommandView(...)`
   - `replyCommandResult(...)`
   - `/switch`、`/workspaces` 等当前直接 `sendCard(chatId, ...)` 的命令实现
   - 所有直接 `ctx.reply(...)` 的命令回包点

3. **补充日志**
   - 增加命令链路日志，例如：
     - `[command] inbound`
     - `[command] dispatch`
     - `[command] reply`
     - `[command] send card`
   - 日志应包含：
     - `chatId`
     - `messageId`
     - `threadId`
     - `cmd`
     - `replyInThread`

4. **补充中文代码注释**
   - 在命令回复的统一封装处说明：
     - 为什么话题内命令要显式使用 `thread_id` 语义
     - 为什么卡片回复不能直接复用普通 `sendCard(chatId, ...)`

5. **建议回归测试**
   - 话题内 `/models` 可以触发，并在同一话题内返回模型列表卡片
   - 话题内 `/mode` 可以触发，并在同一话题内返回模式卡片
   - 话题内 `/switch xxx` 可以触发，并在同一话题内返回文本确认
   - 群顶层 `/命令` 仍保持现有 mention gate 约束
   - 私聊 `/命令` 行为不变

### 当前结论
该改造方向具备明确收益：可以让“配置型操作”和“对话型操作”在飞书群话题中保持一致的交互边界，减少用户对“为什么普通回复在话题里、但命令跳到外面去了”的认知割裂。

但由于涉及命令回包的统一抽象，建议先保留本记录，待确认是否进入下一轮实现。

---

## 待定改造计划：飞书群聊“先发图片、后发文字/引用”触发 Agent

**记录时间**: 2026-08-08  
**状态**: 待评估，暂不修改代码

### 背景
当前飞书私聊里，用户可以先单独发送图片，bot 会先把图片暂存；随后再发送文字时，图片和文字可以一起进入模型。

但在**群聊**里，这个流程存在明显断点：
1. 用户先发图片到群里时，如果**没有 `@bot`**，消息会被前置 mention gate 直接跳过，bot 无法“记住”这张图。
2. 用户后续即便用飞书的**引用/回复**功能，当前实现也只是把 `reply/root` 当成 **session 路由线索**，并不会把被引用的图片重新解析成附件带给模型。

因此，群聊里现在无法顺畅支持“先发图，再发文字解释/提问”的自然用法。

### 当前机制判断
1. **群聊顶层消息受 mention gate 控制**
   - 在 `src/channels/feishu/channel.ts` 中，群消息如果既不属于已放行的话题 thread，又没有匹配到 `@bot`，会被直接跳过。
   - 这意味着“群里先发一张图，不 @bot”在现状下不会进入附件暂存链路。

2. **引用消息目前只参与 Session 匹配**
   - 在 `src/channels/feishu/bot.ts` 中，`replyToMessageId/rootMessageId/threadId` 目前主要用于恢复会话上下文。
   - 但真正的附件解析，仍然只看“当前这条消息”的 `image/file/post` 内容，不会主动去拉取“被引用那条消息”的图片资源。

3. **因此现状是**
   - 私聊支持“先图后文”
   - 群聊不支持“无 @ 的先图后文”
   - 群聊也不支持“引用旧图 + 文字”把旧图一起带入模型

### 推荐方案
建议后续按“**群聊待激活附件池**”思路设计，而不是让群里图片一发就立即触发 Agent。

核心原则：
1. **图片先缓存，不立即调用模型**
2. **只有后续出现明确激活动作时，才把图片和文字一起送入模型**
3. **优先使用用户明确引用的图片，避免群聊串图**

### 建议交互语义
1. **群里先发图片，不 @bot**
   - bot 不回消息，不打断群聊
   - 但本地记录一条“待激活附件”
   - 附件记录建议至少绑定：
     - `chatId`
     - `senderOpenId`
     - `sourceMessageId`
     - `messageType`
     - `downloadedFilePath`
     - `createdAt`

2. **后续出现文字消息时，以下行为可视为激活**
   - `@bot` + 文字
   - 引用/回复之前那张图片 + 文字
   - 已进入 bot 创建的话题 thread 后继续说话

3. **附件拾取优先级**
   - 第一优先：当前文字消息显式引用/回复的那张图
   - 第二优先：当前用户在当前群里最近一条尚未消费的 pending 图片
   - 不建议默认跨人自动拾取，除非用户显式引用

4. **消费规则**
   - 一旦这次文字消息成功带上图片进入模型，对应 pending 附件即标记为已消费
   - 避免后续无意间重复带图

### 分阶段落地建议
1. **V1：先支持“引用图片 + @bot + 文字”**
   - 风险最低
   - 用户意图最明确
   - 先把“引用旧图”真正打通

2. **V1.1：支持“先发图，再直接 @bot + 文字”**
   - 自动拾取同一用户最近一条 pending 图片
   - 体验更顺，但要控制好超时与串图边界

3. **V2：考虑支持 `post` / 富文本里的嵌图**
   - 这一步复杂度更高
   - 可等前两步稳定后再判断是否值得做

### 边界与风控建议
1. pending 附件建议设置 TTL（如 10-15 分钟）
2. 每个用户在每个群里最多缓存 3-5 条，避免状态无限堆积
3. 单次激活最多带入 3 个附件
4. 不建议让“别人发的图”在未引用情况下被自动带入
5. 需要补充日志，至少记录：
   - `[group-attachment] staged`
   - `[group-attachment] activated`
   - `[group-attachment] expired`
   - `[group-attachment] consumed`

### 建议回归测试
1. 群里先发图片（不 @bot），图片被记录为 pending，但不触发模型
2. 群里引用该图片并 `@bot` 发文字，模型收到图片 + 文字
3. 群里不引用，只 `@bot` 发文字，若存在同用户最近 pending 图片，则按规则带入
4. 群里其他用户发文字时，不应误消费别人的 pending 图片
5. 超过 TTL 的 pending 图片不会再被自动带入
6. 私聊现有“先图后文”行为保持不变

### 当前结论
这个问题本质上不是“图片下载失败”，而是**群聊入口 gate 与引用语义缺失**共同造成的交互断层。

如果后续要做，我建议优先实现：
**“群聊待激活附件池 + 引用激活 + @bot 激活”**

这样既能保持群聊安全边界，又能补齐用户最自然的“先发图再问问题”操作路径。当前先保留本记录，待后续确认是否进入实现。
