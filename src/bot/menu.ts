import type { SkillInfo } from '../agent/index.js';
import type { MenuCommand } from '../channels/base.js';

export const SKILL_CMD_PREFIX = 'sk_';

export interface WelcomeIntro {
  title: string;
  subtitle: string;
  version: string;
}

export function buildWelcomeIntro(version: string): WelcomeIntro {
  return {
    title: "Hello，我是pikiloom",
    subtitle: '给我发消息以开始使用。',
    version,
  };
}

export function buildSkillCommandName(skillName: string): string | null {
  const normalized = skillName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!normalized) return null;
  const cmdName = `${SKILL_CMD_PREFIX}${normalized}`;
  if (cmdName.length > 32) return null;
  return cmdName;
}

export function indexSkillsByCommand(skills: SkillInfo[]): Map<string, SkillInfo> {
  const indexed = new Map<string, SkillInfo>();
  for (const skill of skills) {
    const cmdName = buildSkillCommandName(skill.name);
    if (!cmdName || indexed.has(cmdName)) continue;
    indexed.set(cmdName, skill);
  }
  return indexed;
}

export function buildDefaultMenuCommands(agentCount: number, skills: SkillInfo[] = []): MenuCommand[] {
  // 默认菜单命令：description 用于启动通知与 /start 的展示文案，统一使用中文 202608081529
  const commands: MenuCommand[] = [
    { command: 'sessions', description: '切换会话' },
    { command: 'digest', description: '最近会话摘要' },
  ];

  if (agentCount > 1) {
    commands.push({ command: 'agents', description: '切换 Agent' });
  }

  commands.push(
    { command: 'switch', description: '切换工作目录' },
    { command: 'workspaces', description: '选择已保存的工作区' },
    { command: 'models', description: '切换模型' },
    { command: 'mode', description: '切换为计划模式' },
    { command: 'goal', description: '设置/查看长期运行任务' },
    { command: 'stop', description: '停止当前会话' },
    { command: 'status', description: '查看状态' },
    { command: 'host', description: '查看服务器信息' },
  );

  if (skills.length) {
    commands.push({ command: 'skills', description: '浏览已安装技能skills' });
  }

  commands.push({ command: 'ext', description: '扩展概览' });

  if (agentCount === 1) {
    commands.push({ command: 'agents', description: '切换 Agent' });
  }

  commands.push({ command: 'restart', description: '重启机器人' });
  return commands;
}
