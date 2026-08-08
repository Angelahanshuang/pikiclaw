import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuBot } from '../src/channels/feishu/bot.ts';
import { promoteSessionId, stageSessionFiles } from '../src/agent/index.ts';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    chatId: 'oc_group_1',
    messageId: 'om_msg_1',
    from: { openId: 'ou_user_1', userId: 'user_1', name: 'Tester' },
    chatType: 'group',
    replyToMessageId: null,
    threadId: null,
    rootMessageId: null,
    reply: vi.fn(async () => null),
    editReply: vi.fn(async () => undefined),
    channel: {} as any,
    raw: {},
    ...overrides,
  };
}

describe('FeishuBot thread routing', () => {
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'test-app';
    process.env.FEISHU_APP_SECRET = 'test-secret';
  });

  it('binds thread_id from root message lookup and reuses it on later replies', () => {
    const bot = new FeishuBot() as any;
    const session = {
      key: 'session-key-1',
      sessionId: 'sess-1',
      workdir: '/tmp/pikiloom-feishu-thread-test',
      agent: 'codex',
    };

    bot.getSessionRuntimeByKey = vi.fn(() => session);
    bot.hydrateSessionRuntime = vi.fn(() => session);

    bot.registerSessionMessage('oc_group_1', 'om_root_1', session);

    const firstCtx = makeCtx({
      messageId: 'om_msg_2',
      threadId: 'omt_thread_1',
      rootMessageId: 'om_root_1',
      replyToMessageId: 'om_root_1',
    });
    const firstResolved = bot.resolveIncomingSession(firstCtx, '继续处理', []);
    expect(firstResolved).toBe(session);

    const secondCtx = makeCtx({
      messageId: 'om_msg_3',
      threadId: 'omt_thread_1',
    });
    const secondResolved = bot.resolveIncomingSession(secondCtx, '继续跟进', []);
    expect(secondResolved).toBe(session);

    const gateDecision = bot.decideGroupThreadContinuation({
      chatId: 'oc_group_1',
      messageId: 'om_msg_4',
      from: { openId: 'ou_user_1', userId: 'user_1', name: 'Tester' },
      threadId: 'omt_thread_1',
      rootMessageId: null,
      parentMessageId: null,
      raw: {},
    });
    expect(gateDecision).toEqual({ allow: true, reason: 'session=sess-1' });
  });

  it('canonicalizes stale pending message refs so staged files survive the next text turn', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-feishu-promote-'));
    const bot = new FeishuBot() as any;
    const pendingSession = {
      key: 'claude:pending_aaaaaa',
      sessionId: 'pending_aaaaaa',
      workdir,
      workspacePath: path.join(workdir, '.pikiloom/sessions/claude/pending_aaaaaa/workspace'),
      threadId: null,
      agent: 'claude',
      codexCumulative: null,
      modelId: null,
    };

    stageSessionFiles({
      agent: 'claude',
      workdir,
      sessionId: pendingSession.sessionId,
      files: [__filename],
    });
    promoteSessionId(workdir, 'claude', 'pending_aaaaaa', 'native-1');

    bot.registerSessionMessage('oc_group_1', 'om_root_2', pendingSession);
    bot.getSessionRuntimeByKey = vi.fn(() => null);
    const hydrated = vi.fn((sessionRef: any) => sessionRef);
    bot.hydrateSessionRuntime = hydrated;

    const resolved = bot.resolveIncomingSession(makeCtx({
      messageId: 'om_msg_5',
      rootMessageId: 'om_root_2',
      replyToMessageId: 'om_root_2',
    }), '你能看到这个图吗', []);

    expect(resolved.sessionId).toBe('native-1');
    expect(resolved.key).toBe('claude:native-1');
    expect(hydrated).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'native-1',
      key: 'claude:native-1',
      workspacePath: null,
    }));

    fs.rmSync(workdir, { recursive: true, force: true });
  });
});
