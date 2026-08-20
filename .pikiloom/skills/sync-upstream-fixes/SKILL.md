---
name: "sync-upstream-fixes"
description: "同步 upstream/main 到 origin/main，并合入当前自定义分支。用户提到上游修复、主干落后、要同步源仓库或把最新 main 合到 custom 分支时使用。"
version: "1.0.0"
---

# Sync Upstream Fixes

用于把上游仓库 `upstream/main` 的修复安全同步到当前项目，并进一步合入自定义开发分支。

本 skill 适用于当前仓库默认 Git 结构：

- `upstream` = 源仓库
- `origin` = 用户自己的 fork
- `main` = 用户 fork 的主干
- `custom-dev` = 默认自定义开发分支

如果用户明确指定了别的分支名，以用户要求为准。

## 何时使用

当出现以下任一情况时，应使用本 skill：

- 用户说“上游有修复，帮我同步一下”
- 用户说“我的 main 落后 upstream 了”
- 用户说“看看有没有必要同步源仓库”
- 用户说“把最新 main 合到 custom 分支”
- 用户说“把上游核心 bug 修复同步到当前分支”

## 目标

1. 判断 `upstream/main` 是否值得同步
2. 判断同步后是否会影响当前自定义分支
3. 在必要时将 `origin/main` 与 `upstream/main` 对齐
4. 将最新 `main` 合入目标自定义分支
5. 输出清晰的状态结论和后续建议

## 默认执行顺序

### 1. 先拉取远程状态

先执行：

```bash
git fetch --all --prune
```

然后检查：

```bash
git status -sb
git branch -vv
git rev-list --left-right --count origin/main...upstream/main
git log --oneline --left-right origin/main...upstream/main -n 20
```

## 2. 判断“是否值得同步”

优先看上游新增提交是否包含以下目录或类型的改动：

- `src/`
- `packages/kernel/`
- `agent/`
- `bot/`
- `channels/`
- 测试文件
- 修复性提交（`fix:`、bugfix、crash、leak、cleanup、stall 等）

如果仅有文档、徽章、星标图等展示性改动，可以说明“可同步但优先级不高”。

如果存在核心修复或用户明确要求同步，则继续执行，不要停在建议层。

## 3. 检查当前自定义分支是否可能冲突

目标分支处理规则：

- 若用户明确指定分支，使用用户指定分支
- 否则优先使用当前检出的分支
- 若当前分支是 `main`，则默认目标分支为 `custom-dev`

冲突预检建议使用：

```bash
base=$(git merge-base <target-branch> upstream/main)
git merge-tree "$base" <target-branch> upstream/main
```

若输出包含冲突标记：

- 不要直接覆盖用户代码
- 先向用户说明冲突位置和风险
- 再继续人工处理

若无冲突，可继续同步主干与分支合并。

## 4. 同步前先做主干备份

当准备把 `origin/main` 对齐到 `upstream/main` 时，先创建备份分支：

```bash
git branch backup/origin-main-before-sync-YYYYMMDD origin/main
```

这样即使后续需要回看旧主干，也有落点。

## 5. 让本地 main 对齐 upstream/main

先把本地 `main` 指向 `upstream/main`：

```bash
git branch -f main upstream/main
```

如果这是一次“要与源仓库完全一致”的同步，并且用户已明确同意对齐主干，可执行：

```bash
git push --force-with-lease origin main:main
```

注意：

- 只有在“用户明确要求主干与上游一致”时，才执行这一步
- 强推前必须先完成备份
- 强推后应把本地 `main` 的跟踪关系恢复到 `origin/main`

```bash
git branch --set-upstream-to=origin/main main
```

## 6. 把最新 main 合到目标自定义分支

切回目标分支后执行：

```bash
git merge main
```

处理原则：

- 保留用户自定义分支上的业务修改
- 不要为了“合得快”直接丢弃用户代码
- 若遇到冲突，优先保守处理，并向用户汇报涉及文件

## 7. 合并完成后必须核对

至少检查：

```bash
git status -sb
git branch -vv
git log --oneline --decorate -n 5
git rev-list --left-right --count origin/main...upstream/main
```

需要向用户明确说明：

- `origin/main` 是否已和 `upstream/main` 一致
- 目标分支是否已成功合入最新 `main`
- 当前分支是否领先远程
- 是否还需要执行 `git push`

## 安全约束

必须遵守以下约束：

1. 未检查工作区状态前，不要直接切分支或合并
2. 若工作区不干净，先提示用户确认，避免把未提交修改卷进同步流程
3. 不得使用 `git reset --hard`
4. 不得使用 `git checkout --`
5. 不得擅自删除用户分支
6. 若同步目标不是 `custom-dev`，必须在汇报中写清实际使用的目标分支

## 默认汇报模板

建议按下面的结构向用户汇报：

1. 当前远程关系：`origin` / `upstream`
2. `origin/main` 与 `upstream/main` 的差异数量
3. 是否值得同步，以及原因
4. 自定义分支是否存在冲突风险
5. 实际执行了哪些 Git 操作
6. 最终状态：`main`、目标分支、是否需要 push

## 本仓库默认约定

当前仓库默认按以下约定处理：

- 上游主干：`upstream/main`
- 用户主干：`origin/main`
- 默认自定义分支：`custom-dev`

如果未来改成别的分支命名，这份 skill 也要一并更新。

## 典型触发示例

- “检查 upstream 的修复要不要同步”
- “把我的 main 和源仓库对齐”
- “把最新 main 合到 custom-dev”
- “上游修了核心 bug，帮我同步到当前分支”
