import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import { buildForkSeed } from '../src/runtime/fork.js';
import { claudeResumeArgs } from '../src/drivers/claude.js';
import { CodexDriver } from '../src/drivers/codex.js';
import { claudeAnchorResolvable, claudeTranscriptTailAnchor, codexRolloutTailAnchor } from '../src/drivers/native.js';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent } from '../src/contracts/driver.js';

const flushTurns = () => new Promise((r) => setTimeout(r, 50));

// A scripted driver: records every AgentTurnInput, emits a session id, echoes. `forky`
// toggles capabilities.fork + resolveNativeAnchor so both fork modes are exercised.
class ScriptedDriver implements AgentDriver {
  readonly runs: AgentTurnInput[] = [];
  nextNativeId = 'native-1';
  tailAnchor: string | null = 'tail-anchor';
  anchorCalls = 0;
  /** Native ids the agent's own store does NOT hold (a run that died before creating one). */
  readonly missingNative = new Set<string>();
  /** null = the driver can't judge anchors; otherwise only these hydrate. */
  unresolvableAnchors: Set<string> | null = null;
  /** Next run reports a hard pre-flight failure — echoing back the id it was handed, as claude does. */
  failNext = false;
  constructor(readonly id: string, private readonly forky: boolean) {}
  get capabilities() { return { steer: false, interact: false, resume: true, tui: false, fork: this.forky, rewind: this.forky }; }
  resolveNativeAnchor(opts: { sessionId: string; workdir: string }): string | null {
    this.anchorCalls++;
    if (this.missingNative.has(opts.sessionId)) return null;
    return this.forky ? this.tailAnchor : null;
  }
  anchorResolvable(opts: { sessionId: string; workdir: string; anchor: string }): boolean {
    return this.unresolvableAnchors ? !this.unresolvableAnchors.has(opts.anchor) : true;
  }
  async run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    this.runs.push(input);
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, text: '', error: `No message found with message.uuid of: ${input.fork?.anchor}`, sessionId: this.nextNativeId };
    }
    ctx.emit({ type: 'session', sessionId: this.nextNativeId });
    const text = `reply to: ${input.prompt.slice(0, 40)}`;
    ctx.emit({ type: 'text', delta: text });
    return { ok: true, text, sessionId: this.nextNativeId, anchor: `${this.nextNativeId}/a1`, stopReason: 'end_turn' };
  }
}

describe('claudeResumeArgs (fork flag contract)', () => {
  it('plain resume appends to the session', () => {
    expect(claudeResumeArgs('sid')).toEqual(['--resume', 'sid']);
  });
  it('fork at tail adds --fork-session only', () => {
    expect(claudeResumeArgs('sid', {})).toEqual(['--resume', 'sid', '--fork-session']);
    expect(claudeResumeArgs('sid', { anchor: null })).toEqual(['--resume', 'sid', '--fork-session']);
  });
  it('anchored fork adds the inclusive keep-boundary', () => {
    expect(claudeResumeArgs('sid', { anchor: 'uuid-7' }))
      .toEqual(['--resume', 'sid', '--fork-session', '--resume-session-at', 'uuid-7']);
  });
});

describe('buildForkSeed', () => {
  it('role-tags the copied turns and wraps them in fork-context', () => {
    const seed = buildForkSeed([
      { phase: 'done', updatedAt: 1, prompt: 'q1', text: 'a1' },
      { phase: 'done', updatedAt: 2, prompt: 'q2', text: 'a2' },
    ]);
    expect(seed).toContain('<fork-context turns=2>');
    expect(seed).toContain('User: q1');
    expect(seed).toContain('Assistant: a2');
    expect(seed!.trim().endsWith('</fork-context>')).toBe(true);
  });
  it('is null for an empty transcript and tail-truncates whole messages', () => {
    expect(buildForkSeed([])).toBeNull();
    const seed = buildForkSeed([
      { phase: 'done', updatedAt: 1, prompt: 'old '.repeat(50), text: 'old-reply' },
      { phase: 'done', updatedAt: 2, prompt: 'new-question', text: 'new-reply' },
    ], 60);
    expect(seed).toContain('new-reply');
    expect(seed).not.toContain('old-reply');
  });
});

describe('Hub.forkSession', () => {
  let tmp: string;
  let loom: Loom;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-fork-')); });
  afterEach(async () => { await loom?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  async function seedParent(driver: ScriptedDriver): Promise<{ sessionKey: string; taskIds: string[] }> {
    loom = createLoom({ drivers: [driver as AgentDriver], defaultAgent: driver.id, sessionStore: new FsSessionStore(tmp), workdir: tmp });
    driver.nextNativeId = 'native-parent';
    const first = await loom.io.prompt({ prompt: 'first question' });
    await flushTurns();
    const second = await loom.io.prompt({ prompt: 'second question', sessionKey: first.sessionKey });
    await flushTurns();
    return { sessionKey: first.sessionKey, taskIds: [first.taskId, second.taskId] };
  }

  it('native mode: copies the kept prefix, pins the anchor, and fork-dispatches off the parent native id', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey, taskIds } = await seedParent(driver);

    // Fork at turn 1 (mid cut): the anchor comes from that turn's recorded DriverResult.anchor.
    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0] });
    expect(forkKey).not.toBe(sessionKey);

    const forked = await loom.io.getHistory(forkKey);
    expect(forked.map(t => t.prompt)).toEqual(['first question']);   // prefix copied, cut respected
    expect(forked[0].taskId).toBe(taskIds[0]);

    const store = new FsSessionStore(tmp);
    const rec = (await store.get('forky', forkKey.split(':')[1]))!;
    expect(rec.forkedFrom).toEqual({ sessionKey, taskId: taskIds[0] });
    expect(rec.pendingFork).toEqual({ parentNativeSessionId: 'native-parent', anchor: 'native-parent/a1', mode: 'native' });
    expect(rec.runState).toBe('completed');   // no live turn yet — must not read as running

    // First dispatch consumes the fork: driver sees the PARENT native id + fork.anchor, clean prompt.
    driver.nextNativeId = 'native-branch';
    await loom.io.prompt({ prompt: 'branch question', sessionKey: forkKey });
    await flushTurns();
    const forkRun = driver.runs.at(-1)!;
    expect(forkRun.sessionId).toBe('native-parent');
    expect(forkRun.fork).toEqual({ anchor: 'native-parent/a1' });
    expect(forkRun.prompt).toBe('branch question');                  // native mode: no seed prepend

    // The branch materialized: pendingFork consumed, native id recorded, parent untouched.
    const settled = (await store.get('forky', forkKey.split(':')[1]))!;
    expect(settled.pendingFork).toBeNull();
    expect(settled.nativeSessionId).toBe('native-branch');
    const parent = (await store.get('forky', sessionKey.split(':')[1]))!;
    expect(parent.nativeSessionId).toBe('native-parent');
    expect(parent.forkedFrom ?? null).toBeNull();
    expect((await loom.io.getHistory(sessionKey)).length).toBe(2);

    // Follow-up turns on the branch resume IT normally — no fork flag anymore.
    await loom.io.prompt({ prompt: 'follow-up', sessionKey: forkKey });
    await flushTurns();
    const next = driver.runs.at(-1)!;
    expect(next.sessionId).toBe('native-branch');
    expect(next.fork ?? null).toBeNull();
  });

  it('tail fork pins the parent tail anchor via resolveNativeAnchor', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey } = await seedParent(driver);
    // Recorded turn anchors exist, so the kept-last-turn anchor wins and resolveNativeAnchor
    // is NOT consulted; drop the recorded anchor by forking a session with bare history.
    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey });
    const store = new FsSessionStore(tmp);
    const rec = (await store.get('forky', forkKey.split(':')[1]))!;
    expect(rec.pendingFork!.anchor).toBe('native-parent/a1');   // from the recorded turn anchor
    expect(driver.anchorCalls).toBe(0);
  });

  it('seed mode: a driver without capabilities.fork gets a fresh session with a replayed prefix', async () => {
    const driver = new ScriptedDriver('plain', false);
    const { sessionKey, taskIds } = await seedParent(driver);

    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0] });
    const store = new FsSessionStore(tmp);
    const rec = (await store.get('plain', forkKey.split(':')[1]))!;
    expect(rec.pendingFork!.mode).toBe('seed');

    driver.nextNativeId = 'native-seeded';
    await loom.io.prompt({ prompt: 'branch question', sessionKey: forkKey });
    await flushTurns();
    const forkRun = driver.runs.at(-1)!;
    expect(forkRun.sessionId).toBeNull();                        // fresh native session
    expect(forkRun.fork ?? null).toBeNull();
    expect(forkRun.prompt).toContain('<fork-context turns=1>');  // replayed prefix rides the prompt
    expect(forkRun.prompt).toContain('User: first question');
    expect(forkRun.prompt).not.toContain('second question');     // cut respected
    expect(forkRun.prompt.trim().endsWith('branch question')).toBe(true);

    const settled = (await store.get('plain', forkKey.split(':')[1]))!;
    expect(settled.pendingFork).toBeNull();
    expect(settled.nativeSessionId).toBe('native-seeded');
  });

  it('a fork-capable driver still falls back to seed when a MID cut has no anchor', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey, taskIds } = await seedParent(driver);
    // Simulate pre-anchor-era turns: strip recorded anchors from the parent transcript.
    const parentId = sessionKey.split(':')[1];
    const turnsPath = path.join(tmp, 'forky', parentId, 'turns.jsonl');
    const stripped = fs.readFileSync(turnsPath, 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.stringify({ ...JSON.parse(l), anchor: null })).join('\n') + '\n';
    fs.writeFileSync(turnsPath, stripped);

    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0] });
    const store = new FsSessionStore(tmp);
    expect((await store.get('forky', forkKey.split(':')[1]))!.pendingFork!.mode).toBe('seed');

    // …while an explicit anchor override (e.g. resolved from the app's own native-transcript
    // parse) restores native mode for the same cut.
    const { sessionKey: forkKey2 } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0], anchor: 'app-resolved' });
    const rec2 = (await store.get('forky', forkKey2.split(':')[1]))!;
    expect(rec2.pendingFork).toEqual({ parentNativeSessionId: 'native-parent', anchor: 'app-resolved', mode: 'native' });
  });

  it('rejects an unknown fork point', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey } = await seedParent(driver);
    await expect(loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: 'nope' })).rejects.toThrow(/fork point/);
  });

  it('drops an anchor the driver can no longer resolve: a mid cut seeds instead of dying', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey, taskIds } = await seedParent(driver);
    driver.unresolvableAnchors = new Set(['native-parent/a1']);   // e.g. behind a /compact boundary

    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0] });
    const store = new FsSessionStore(tmp);
    const rec = (await store.get('forky', forkKey.split(':')[1]))!;
    expect(rec.pendingFork).toEqual({ parentNativeSessionId: 'native-parent', anchor: null, mode: 'seed' });

    // …and the branch actually runs: seeded, so the copied prefix rides the prompt.
    driver.nextNativeId = 'native-seeded';
    await loom.io.prompt({ prompt: 'branch question', sessionKey: forkKey });
    await flushTurns();
    expect(driver.runs.at(-1)!.prompt).toContain('User: first question');
    expect((await store.get('forky', forkKey.split(':')[1]))!.nativeSessionId).toBe('native-seeded');
  });

  it('drops an unresolvable anchor on a TAIL cut and re-pins the parent tail instead', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey } = await seedParent(driver);
    driver.unresolvableAnchors = new Set(['native-parent/a1']);

    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey });
    const rec = (await new FsSessionStore(tmp).get('forky', forkKey.split(':')[1]))!;
    expect(rec.pendingFork).toEqual({ parentNativeSessionId: 'native-parent', anchor: 'tail-anchor', mode: 'native' });
    expect(driver.anchorCalls).toBe(1);   // consulted only because the recorded anchor was dropped
  });

  it('a fork whose first turn dies without a native session keeps the intent and re-forks', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey, taskIds } = await seedParent(driver);
    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0] });
    const forkId = forkKey.split(':')[1];
    const store = new FsSessionStore(tmp);

    // The agent rejects the run outright but still echoes back a session id it never created.
    driver.nextNativeId = 'native-branch';
    driver.missingNative.add('native-branch');
    driver.failNext = true;
    await loom.io.prompt({ prompt: 'branch question', sessionKey: forkKey });
    await flushTurns();

    const dead = (await store.get('forky', forkId))!;
    expect(dead.nativeSessionId ?? null).toBeNull();     // never pin a phantom id…
    expect(dead.pendingFork!.mode).toBe('native');       // …so the fork intent survives
    expect(dead.runState).toBe('incomplete');

    // The retry forks again off the parent — not a doomed resume of the phantom id.
    driver.missingNative.delete('native-branch');
    await loom.io.prompt({ prompt: 'try again', sessionKey: forkKey });
    await flushTurns();
    const retry = driver.runs.at(-1)!;
    expect(retry.sessionId).toBe('native-parent');
    expect(retry.fork).toEqual({ anchor: 'native-parent/a1' });
    const settled = (await store.get('forky', forkId))!;
    expect(settled.nativeSessionId).toBe('native-branch');
    expect(settled.pendingFork).toBeNull();
  });

  it('a failed turn that DID create its native session still records the id', async () => {
    const driver = new ScriptedDriver('forky', true);
    const { sessionKey, taskIds } = await seedParent(driver);
    const { sessionKey: forkKey } = await loom.io.forkSession({ fromSessionKey: sessionKey, atTaskId: taskIds[0] });

    driver.nextNativeId = 'native-branch';   // present in the native store: the fork landed…
    driver.failNext = true;                  // …and the turn failed afterwards
    await loom.io.prompt({ prompt: 'branch question', sessionKey: forkKey });
    await flushTurns();

    const rec = (await new FsSessionStore(tmp).get('forky', forkKey.split(':')[1]))!;
    expect(rec.nativeSessionId).toBe('native-branch');
    expect(rec.pendingFork).toBeNull();      // the branch exists — a retry must resume it, not re-fork
  });
});

describe('CodexDriver fork (hermetic fake app-server)', () => {
  let tmp: string; let fake: string;
  const FAKE = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/fork') {
      // Echo the fork params back through the answer so the test can pin them.
      globalThis.FORKED = { from: m.params.threadId, lastTurnId: m.params.lastTurnId ?? null };
      reply(m.id, { thread: { id: 'thread-branch', forkedFromId: m.params.threadId } });
    }
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: m.params.threadId, turn: { id: 'turn-9' } });
      notify('item/agentMessage/delta', { threadId: m.params.threadId, itemId: 'm1', delta: 'forked:' + JSON.stringify(globalThis.FORKED) });
      notify('turn/completed', { threadId: m.params.threadId, turn: { id: 'turn-9', status: 'completed' } });
    }
  }
});
`;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-fork-'));
    fake = path.join(tmp, 'fake-codex');
    fs.writeFileSync(fake, FAKE, { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('fork dispatch goes through thread/fork with lastTurnId and adopts the branch thread id', async () => {
    const driver = new CodexDriver(fake);
    const events: DriverEvent[] = [];
    const ctx: DriverContext = { signal: new AbortController().signal, emit: (e) => events.push(e), askUser: async () => ({}), registerSteer: () => {} };
    const res = await driver.run({ prompt: 'branch it', workdir: tmp, sessionId: 'thread-parent', fork: { anchor: 'turn-1' } }, ctx);
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe('thread-branch');
    expect(res.anchor).toBe('turn-9');
    expect(res.text).toContain('"from":"thread-parent"');
    expect(res.text).toContain('"lastTurnId":"turn-1"');
    const session = events.find(e => e.type === 'session') as { sessionId: string };
    expect(session.sessionId).toBe('thread-branch');
  });
});

describe('native tail anchors', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-anchor-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('claudeTranscriptTailAnchor returns the last user/assistant record uuid', () => {
    const workdir = '/tmp/proj';
    const dir = path.join(home, '.claude', 'projects', '-tmp-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'q' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ type: 'last-prompt' }),
    ].join('\n') + '\n');
    expect(claudeTranscriptTailAnchor(workdir, 'sess-1', { home })).toBe('a1');
    expect(claudeTranscriptTailAnchor(workdir, 'missing', { home })).toBeNull();
  });

  // The exact hydration rule claude's --resume-session-at enforces: active leaf chain only, and
  // only back to the last /compact boundary (which re-roots the transcript with a parentless
  // record). A pre-compaction uuid — even an assistant reply — fails the whole run.
  it('claudeAnchorResolvable tracks the active chain back to the last compaction boundary', () => {
    const workdir = '/tmp/proj';
    const dir = path.join(home, '.claude', 'projects', '-tmp-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), [
      JSON.stringify({ type: 'user', uuid: 'old-u', parentUuid: null }),
      JSON.stringify({ type: 'assistant', uuid: 'old-a', parentUuid: 'old-u' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'bnd', parentUuid: null, logicalParentUuid: 'old-a' }),
      JSON.stringify({ type: 'user', uuid: 'sum', parentUuid: 'bnd', isCompactSummary: true }),
      JSON.stringify({ type: 'assistant', uuid: 'new-a', parentUuid: 'sum' }),
      JSON.stringify({ type: 'user', uuid: 'side', parentUuid: 'new-a', isSidechain: true }),
    ].join('\n') + '\n');

    expect(claudeAnchorResolvable(workdir, 'sess-1', 'new-a', { home })).toBe(true);
    expect(claudeAnchorResolvable(workdir, 'sess-1', 'sum', { home })).toBe(true);
    expect(claudeAnchorResolvable(workdir, 'sess-1', 'old-a', { home })).toBe(false);   // behind /compact
    expect(claudeAnchorResolvable(workdir, 'sess-1', 'old-u', { home })).toBe(false);
    expect(claudeAnchorResolvable(workdir, 'sess-1', 'nope', { home })).toBe(false);
    // A sidechain (subagent) record is never the chain leaf, so the main chain still resolves.
    expect(claudeAnchorResolvable(workdir, 'sess-1', 'side', { home })).toBe(false);
    // Inconclusive reads must not downgrade a healthy fork.
    expect(claudeAnchorResolvable(workdir, 'missing', 'new-a', { home })).toBe(true);
  });

  it('claudeAnchorResolvable walks a dead rewind branch off the ACTIVE leaf only', () => {
    const workdir = '/tmp/proj';
    const dir = path.join(home, '.claude', 'projects', '-tmp-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-2.jsonl'), [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1' }),
      JSON.stringify({ type: 'assistant', uuid: 'dead', parentUuid: 'a1' }),   // abandoned by a rewind
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1' }),          // regenerated branch
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2' }),
    ].join('\n') + '\n');
    expect(claudeAnchorResolvable(workdir, 'sess-2', 'a1', { home })).toBe(true);
    expect(claudeAnchorResolvable(workdir, 'sess-2', 'dead', { home })).toBe(false);
  });

  it('codexRolloutTailAnchor returns the last turn id in the rollout', () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '07', '12');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-07-12T00-00-00-th-42.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'th-42', cwd: '/tmp' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-A' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-A' } }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-B' } }),
    ].join('\n') + '\n');
    expect(codexRolloutTailAnchor('th-42', { home })).toBe('turn-B');
    expect(codexRolloutTailAnchor('th-nope', { home })).toBeNull();
  });
});
