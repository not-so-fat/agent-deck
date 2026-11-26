/**
 * NOT-672: Claude worker policy — isolated settings, canUseTool-gated default mode, explicit
 * tool lists and profile allow/deny rules, and the read-only shell
 * classifier behind `canUseTool`.
 *
 * Enforcement lives in the generated settings and in `decideClaudeToolCall`
 * — never in prompt instructions. The fixtures below pin the verdict for
 * compound Bash, git, gh, curl, Python, WebFetch, and Monitor in both
 * profiles.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_EDIT_ASK_TOOLS,
  CLAUDE_EDIT_DENY_RULES,
  CLAUDE_READONLY_ASK_TOOLS,
  CLAUDE_READONLY_DENY_RULES,
  CLAUDE_WORKER_BASE_TOOLS,
  CLAUDE_WORKER_MCP_TOOL_PREFIX,
  CLAUDE_WORKER_PERMISSION_MODE,
  CLAUDE_WORKER_SETTING_SOURCES,
  CLAUDE_WORKER_SKILLS,
  claudeAllowedToolsForProfile,
  claudeAskRulesForProfile,
  claudeDenialTargetForInput,
  claudeDenyRulesForProfile,
  claudeMcpToolRules,
  claudeSettingsForProfile,
  classifyReadonlyShell,
  decideClaudeToolCall,
  isEditFileWriteInScope,
  isReadonlyShellCommand,
  type ClaudePolicyContext,
} from './claude-policy';
import { WORKER_PROFILES } from './profiles';

const CTX = (profile: 'readonly' | 'edit'): ClaudePolicyContext => ({
  profile,
  cwd: path.join(os.tmpdir(), 'ad-policy-ws'),
  homeDir: path.join(os.tmpdir(), 'ad-policy-home'),
  tmpDir: os.tmpdir(),
});

describe('claude worker settings and tool lists (NOT-672)', () => {
  it('uses isolated setting sources, default mode, and no skills', () => {
    expect([...CLAUDE_WORKER_SETTING_SOURCES]).toEqual([]);
    expect(CLAUDE_WORKER_PERMISSION_MODE).toBe('default');
    expect([...CLAUDE_WORKER_SKILLS]).toEqual([]);
  });

  it('readonly allows reads, web reads, todos, and MCP reads — never writes or shell', () => {
    const allow = claudeAllowedToolsForProfile('readonly');
    for (const tool of CLAUDE_WORKER_BASE_TOOLS) {
      expect(allow).toContain(tool);
    }
    expect(allow).toContain(`${CLAUDE_WORKER_MCP_TOOL_PREFIX}get_run`);
    // Nothing shell-shaped may pre-approve: every Bash call routes through
    // ask to the host gate, so no prefix pattern can skip the classifier.
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Monitor', 'Bash']) {
      expect(allow).not.toContain(tool);
    }
    expect(allow.filter((rule) => rule === 'Bash' || rule.startsWith('Bash('))).toEqual([]);
    expect(claudeDenyRulesForProfile('readonly')).toEqual([...CLAUDE_READONLY_DENY_RULES]);
    expect(claudeAskRulesForProfile('readonly')).toEqual([...CLAUDE_READONLY_ASK_TOOLS]);
    expect(claudeAskRulesForProfile('readonly')).toEqual(['Bash']);
  });

  it('edit allows subagents, tasks, Monitor, and MCP — shell and writes route through ask', () => {
    const allow = claudeAllowedToolsForProfile('edit');
    for (const tool of [...CLAUDE_WORKER_BASE_TOOLS, 'Agent', 'Monitor', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
      expect(allow).toContain(tool);
    }
    expect(allow).toContain(`${CLAUDE_WORKER_MCP_TOOL_PREFIX}bind_workspace`);
    // Shell and file writes are ask-routed, never pre-approved: the host
    // gate decides every call (classifier/sandbox veto, write scope).
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      expect(allow).not.toContain(tool);
    }
    expect(allow.filter((rule) => rule === 'Bash' || rule.startsWith('Bash('))).toEqual([]);
    expect(claudeDenyRulesForProfile('edit')).toEqual([...CLAUDE_EDIT_DENY_RULES]);
    expect(claudeAskRulesForProfile('edit')).toEqual([...CLAUDE_EDIT_ASK_TOOLS]);
    expect(claudeAskRulesForProfile('edit')).toEqual(['Bash', 'Edit', 'Write', 'NotebookEdit']);
  });

  it('allow, ask, and deny are pairwise disjoint in both profiles', () => {
    for (const profile of ['readonly', 'edit'] as const) {
      const allow = new Set(claudeAllowedToolsForProfile(profile));
      const ask = claudeAskRulesForProfile(profile);
      const deny = claudeDenyRulesForProfile(profile);
      for (const rule of [...ask, ...deny]) {
        expect(allow.has(rule), `${profile} allow/ask-deny overlap on ${rule}`).toBe(false);
      }
      for (const rule of ask) {
        expect(deny.includes(rule), `${profile} ask/deny overlap on ${rule}`).toBe(false);
      }
    }
  });

  it('enumerates exactly the shared profile MCP allow sets (no wildcard)', () => {
    for (const profile of ['readonly', 'edit'] as const) {
      const rules = claudeMcpToolRules(profile);
      expect(rules).toHaveLength(WORKER_PROFILES[profile].mcpAllowTools.length);
      for (const tool of WORKER_PROFILES[profile].mcpAllowTools) {
        expect(rules).toContain(`${CLAUDE_WORKER_MCP_TOOL_PREFIX}${tool}`);
      }
      expect(rules.join(' ')).not.toContain('*');
      expect(claudeAllowedToolsForProfile(profile).join('\n')).not.toContain('mcp__agent-deck__*');
    }
    // Denied tools are absent from both enumerations.
    expect(claudeMcpToolRules('edit')).not.toContain(`${CLAUDE_WORKER_MCP_TOOL_PREFIX}switch_deck`);
    expect(claudeMcpToolRules('readonly')).not.toContain(`${CLAUDE_WORKER_MCP_TOOL_PREFIX}bind_workspace`);
  });

  it('builds flag-layer settings with allow/ask/deny and working dirs', () => {
    const settings = claudeSettingsForProfile('readonly', { homeDir: '/home/agent', tmpDir: '/tmp' });
    expect(settings.permissions.allow).toEqual(claudeAllowedToolsForProfile('readonly'));
    expect(settings.permissions.deny).toEqual(claudeDenyRulesForProfile('readonly'));
    expect(settings.permissions.ask).toEqual(claudeAskRulesForProfile('readonly'));
    expect(settings.permissions.ask).toEqual(['Bash']);
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings.permissions.additionalDirectories).toEqual(['/home/agent', '/tmp']);
    // The SDK option list and the settings rules are the same source: the
    // two can never drift.
    const edit = claudeSettingsForProfile('edit', { homeDir: '/h', tmpDir: '/t' });
    expect(edit.permissions.allow).toEqual(claudeAllowedToolsForProfile('edit'));
    expect(edit.permissions.ask).toEqual(claudeAskRulesForProfile('edit'));
  });
});

describe('read-only shell classifier (NOT-672)', () => {
  const ALLOWED = [
    'ls',
    'ls -la /tmp/x',
    '/bin/ls -la',
    'cat README.md',
    'head -n 20 file | tail -n 5',
    'find . -name "*.ts" -not -path "*/node_modules/*"',
    'grep -rn "needle" src --include="*.ts"',
    'git log --oneline -20',
    'git status --porcelain',
    'git diff HEAD~1 --stat',
    'git show HEAD:pkg/a.ts | head',
    'git rev-parse HEAD',
    'git ls-files | wc -l',
    'git blame -L 1,10 file',
    'git stash list',
    'git branch -a',
    'git branch --show-current',
    'git tag -l "v*"',
    'git config --get user.name',
    'git config user.name',
    'git remote -v',
    'git remote',
    'git clean -ndx',
    'git clean -n -e "*.log"',
    'git apply --check fix.patch',
    'git worktree list',
    'git submodule status',
    'git notes list',
    'git tag',
    'git branch -av',
    'gh pr view 12 --json title,body',
    'gh issue list --limit 20',
    'gh search repos "agent deck"',
    'gh auth status',
    'gh status',
    'gh repo view --json name',
    'gh run list --limit 5',
    'gh release list',
    'gh gist view abc123',
    'npm view react version',
    'npm ls --depth=0',
    'npm ping',
    'tar -tzf bundle.tgz',
    'tar --list -f bundle.tar',
    'unzip -l bundle.zip',
    'unzip -Z1 bundle.zip',
    'cat < input.txt',
    'ls 2>&1 | head',
    'cd /tmp && ls',
    '! grep -q needle file',
    'time ls -la',
    'command -v node',
    'command ls /tmp',
    'ls; pwd; whoami',
    'git log --format="%h;%d" -5',
    'echo "a;b" | cut -d";" -f1',
    'sort names.txt | uniq -c | sort -rn | head',
    'uniq -c names.txt',
    'date -u +%FT%TZ',
    'hostname --fqdn',
    'rg --version',
    'base64 -d bundle.b64 | tar -tzf -',
    'ls &',
    'echo "semi;colon" && pwd',
  ];

  const DENIED: Array<[string, RegExp]> = [
    ['', /empty command/],
    ['   ', /empty command/],
    ['rm -rf /tmp/x', /not a read-only command/],
    ['echo hi > /tmp/x', /output redirection/],
    ['echo hi >> /tmp/x', /output redirection/],
    ['ls 2> /tmp/err', /output redirection/],
    ['uniq a.txt b.txt', /not a read-only command/],
    ['sort data -o sorted', /not a read-only command/],
    ['ls; rm -rf /tmp/x', /not a read-only command/],
    ['git status && curl -X POST http://127.0.0.1:9/x', /not a read-only command/],
    ['git log $(whoami)', /command substitution/],
    ['echo `whoami`', /command substitution/],
    ['echo "$(whoami)"', /command substitution/],
    ['echo $((1 + 1))', /arithmetic expansion/],
    ['(cd /tmp && ls)', /subshells/],
    ['curl http://127.0.0.1:1110/mcp', /not a read-only command/],
    ['curl -X POST http://127.0.0.1:9/x -d a=b', /not a read-only command/],
    ['wget http://example.test/x', /not a read-only command/],
    ['python3 -c "print(1)"', /not a read-only command/],
    ['node -e "console.log(1)"', /not a read-only command/],
    ['npm install', /not a read-only command/],
    ['npm run build', /not a read-only command/],
    ['npx tsc', /not a read-only command/],
    ['bash -c "ls"', /not a read-only command/],
    ['sh script.sh', /not a read-only command/],
    ['sudo ls', /not a read-only command/],
    ['env', /not a read-only command/],
    ['printenv HOME', /not a read-only command/],
    ['export FOO=bar', /not a read-only command/],
    ['git push origin main', /not a read-only command/],
    ['git commit -m x', /not a read-only command/],
    ['git add .', /not a read-only command/],
    ['git checkout -b feat', /not a read-only command/],
    ['git checkout main', /not a read-only command/],
    ['git checkout -- file', /not a read-only command/],
    ['git restore file', /not a read-only command/],
    ['git reset --hard', /not a read-only command/],
    ['git merge main', /not a read-only command/],
    ['git rebase main', /not a read-only command/],
    ['git switch main', /not a read-only command/],
    ['git branch feat', /not a read-only command/],
    ['git branch -D feat', /not a read-only command/],
    ['git branch -m a b', /not a read-only command/],
    ['git tag v1', /not a read-only command/],
    ['git tag -a v1 -m x', /not a read-only command/],
    ['git stash push', /not a read-only command/],
    ['git stash', /not a read-only command/],
    ['git stash show', /not a read-only command/],
    ['git clean -fdx', /not a read-only command/],
    ['git clean -i', /not a read-only command/],
    ['git clean -en -f', /not a read-only command/],
    ['git config user.name evil', /not a read-only command/],
    ['git config --add a b', /not a read-only command/],
    ['git config --edit', /not a read-only command/],
    ['git remote add o http://x', /not a read-only command/],
    ['git remote -v add o http://x', /not a read-only command/],
    ['git apply fix.patch', /not a read-only command/],
    ['git archive -o /tmp/x HEAD', /not a read-only command/],
    ['git worktree add ../w', /not a read-only command/],
    ['git submodule add http://x/y', /not a read-only command/],
    ['git notes add -m x', /not a read-only command/],
    ['git fetch origin', /not a read-only command/],
    ['git pull', /not a read-only command/],
    ['git clone http://x/y', /not a read-only command/],
    ['git log --output=/tmp/x', /not a read-only command/],
    ['git diff --output /tmp/x', /not a read-only command/],
    ['git -c core.pager=evil log', /not a read-only command/],
    ['git grep --open-files-in-pager=evil needle', /not a read-only command/],
    // The hardened rewrite is executed, not re-classified: direct input
    // with global flags fails closed (the model retries bare).
    ['git --no-pager log', /not a read-only command/],
    ['gh pr create --title x', /not a read-only command/],
    ['gh pr merge 1', /not a read-only command/],
    ['gh pr checkout 1', /not a read-only command/],
    ['gh issue create', /not a read-only command/],
    ['gh repo clone a/b', /not a read-only command/],
    ['gh release download v1', /not a read-only command/],
    ['gh release create v1', /not a read-only command/],
    ['gh run rerun 1', /not a read-only command/],
    ['gh gist create f', /not a read-only command/],
    ['gh api repos/a/b --method POST', /not a read-only command/],
    ['gh auth login', /not a read-only command/],
    ['gh auth status --show-token', /not a read-only command/],
    ['gh pr view 1 --web', /not a read-only command/],
    ['gh pr view -qw 1', /not a read-only command/],
    ['find . -exec rm {} \\;', /not a read-only command/],
    ['find . -ok rm {} \\;', /not a read-only command/],
    ['find . -delete', /not a read-only command/],
    ['find . -fls /tmp/x', /not a read-only command/],
    ['tar -xzf bundle.tgz', /not a read-only command/],
    ['tar -cf out.tar src', /not a read-only command/],
    ['tar -t --to-command=evil -f a.tar', /not a read-only command/],
    ['tar -to-command=evil -f a.tar', /not a read-only command/],
    ['tar -t --checkpoint-action=exec=evil -f a.tar', /not a read-only command/],
    ['unzip bundle.zip', /not a read-only command/],
    ['unzip -o bundle.zip', /not a read-only command/],
    ['sed -i s/a/b/ file', /not a read-only command/],
    ['sed -n p file', /not a read-only command/],
    ['awk \'{print}\' file', /not a read-only command/],
    ['ls | xargs rm', /not a read-only command/],
    ['rg --pre evil needle', /not a read-only command/],
    ['rg --hostname-bin=evil needle', /not a read-only command/],
    ['sort -T /tmp data', /not a read-only command/],
    ['sort --compress-program=evil data', /not a read-only command/],
    ['uniq -f 1 a b', /not a read-only command/],
    ['date -s "2026-01-01"', /not a read-only command/],
    ['date --set=x', /not a read-only command/],
    ['base64 -o /tmp/x', /not a read-only command/],
    ['hostname evil', /not a read-only command/],
    ['if [ -f x ]; then cat x; fi', /not a read-only command/],
    ['for f in *.ts; do cat $f; done', /not a read-only command/],
    ['ls | tee /tmp/x', /not a read-only command/],
    ['sqlite3 db "select 1"', /not a read-only command/],
    ['docker ps', /not a read-only command/],
    ['ssh host ls', /not a read-only command/],
    ['echo "oops', /not a read-only command/],
    ['ls # x; rm -rf /tmp/y', /not a read-only command/],
  ];

  it.each(ALLOWED.map((command) => [command] as const))('allows %j', (command) => {
    expect(isReadonlyShellCommand(command)).toBe(true);
  });

  it('allows bare clients (usage)', () => {
    for (const command of ['git', 'gh', 'npm']) {
      expect(isReadonlyShellCommand(command)).toBe(true);
    }
  });

  it.each(DENIED)('denies %j', (command, reason) => {
    const verdict = classifyReadonlyShell(command);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toMatch(reason);
    }
  });

  it('reports which compound segment failed', () => {
    const verdict = classifyReadonlyShell('ls && pwd && rm -rf /tmp/x && whoami');
    expect(verdict).toMatchObject({ allowed: false, segment: 2 });
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('segment 3');
      expect(verdict.reason).toContain('`rm`');
    }
  });

  it('hardens allowed git segments with --no-pager and --no-ext-diff', () => {
    expect(classifyReadonlyShell('git log --oneline')).toEqual({
      allowed: true,
      rewrittenCommand: 'git --no-pager log --no-ext-diff --oneline',
    });
    expect(classifyReadonlyShell('git status')).toEqual({
      allowed: true,
      rewrittenCommand: 'git --no-pager status',
    });
    expect(classifyReadonlyShell('git diff HEAD | head')).toEqual({
      allowed: true,
      rewrittenCommand: 'git --no-pager diff --no-ext-diff HEAD | head',
    });
    // Non-git commands pass through byte-identical.
    expect(classifyReadonlyShell('ls -la | head')).toEqual({ allowed: true });
  });
});

describe('claude tool-call decisions (NOT-672)', () => {
  it('both profiles allow reads, web reads, and todos', () => {
    for (const profile of ['readonly', 'edit'] as const) {
      for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite']) {
        expect(decideClaudeToolCall(tool, {}, CTX(profile))).toEqual({ decision: 'allow' });
      }
    }
  });

  it('both profiles deny questions, skills, and the unlisted tail with kinds', () => {
    for (const profile of ['readonly', 'edit'] as const) {
      expect(decideClaudeToolCall('AskUserQuestion', { questions: [] }, CTX(profile))).toMatchObject({
        decision: 'deny',
        kind: 'client_tool',
      });
      expect(decideClaudeToolCall('Skill', { skill: 'x' }, CTX(profile)).decision).toBe('deny');
      for (const tool of ['TaskStop', 'ToolSearch', 'EnterPlanMode', 'CronCreate', 'ListMcpResources', 'NoSuchTool']) {
        const verdict = decideClaudeToolCall(tool, {}, CTX(profile));
        expect(verdict.decision, `${profile} ${tool}`).toBe('deny');
      }
    }
  });

  it('readonly gates Bash through the classifier; edit allows any shell', () => {
    expect(decideClaudeToolCall('Bash', { command: 'ls -la' }, CTX('readonly'))).toEqual({ decision: 'allow' });
    const denied = decideClaudeToolCall('Bash', { command: 'curl -X POST http://x' }, CTX('readonly'));
    expect(denied).toMatchObject({ decision: 'deny', kind: 'shell' });
    const hardened = decideClaudeToolCall('Bash', { command: 'git status' }, CTX('readonly'));
    expect(hardened).toEqual({ decision: 'allow', updatedCommand: 'git --no-pager status' });
    expect(decideClaudeToolCall('Bash', { command: 'rm -rf /' }, CTX('edit'))).toEqual({ decision: 'allow' });
    // Sandbox escapes are denied in both profiles.
    for (const profile of ['readonly', 'edit'] as const) {
      expect(
        decideClaudeToolCall('Bash', { command: 'ls', dangerouslyDisableSandbox: true }, CTX(profile)).decision,
      ).toBe('deny');
    }
  });

  it('readonly denies file writes; edit scopes them to workspace, home, and temp', () => {
    const ctx = CTX('readonly');
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      const verdict = decideClaudeToolCall(tool, { file_path: '/tmp/x', notebook_path: '/tmp/x' }, ctx);
      expect(verdict).toMatchObject({ decision: 'deny', kind: 'file_write' });
    }
    const edit = CTX('edit');
    expect(decideClaudeToolCall('Write', { file_path: path.join(edit.cwd, 'a.ts') }, edit)).toEqual({ decision: 'allow' });
    expect(decideClaudeToolCall('Edit', { file_path: path.join(edit.homeDir, 'n.md') }, edit)).toEqual({ decision: 'allow' });
    expect(decideClaudeToolCall('Write', { file_path: path.join(edit.tmpDir, 'scratch') }, edit)).toEqual({ decision: 'allow' });
    expect(decideClaudeToolCall('Write', { file_path: 'rel/a.ts' }, edit)).toEqual({ decision: 'allow' });
    expect(
      decideClaudeToolCall('NotebookEdit', { notebook_path: path.join(edit.cwd, 'n.ipynb'), new_source: 'x' }, edit),
    ).toEqual({ decision: 'allow' });
    for (const target of ['/etc/hostname', '/var/tmp/x', '', 42, undefined]) {
      const verdict = decideClaudeToolCall('Write', { file_path: target }, edit);
      expect(verdict.decision, String(target)).toBe('deny');
      if (verdict.decision === 'deny') {
        expect(verdict.kind).toBe('file_write');
      }
    }
    expect(isEditFileWriteInScope(path.join(edit.cwd, 'a'), edit)).toBe(true);
    expect(isEditFileWriteInScope('/etc/hostname', edit)).toBe(false);
  });

  it('readonly denies subagents, tasks, and Monitor; edit allows them', () => {
    for (const tool of ['Agent', 'Monitor', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
      expect(decideClaudeToolCall(tool, {}, CTX('readonly'))).toMatchObject({ decision: 'deny', kind: 'client_tool' });
      expect(decideClaudeToolCall(tool, {}, CTX('edit'))).toEqual({ decision: 'allow' });
    }
  });

  it('names the denied command or path as the denial target', () => {
    expect(claudeDenialTargetForInput('Bash', { command: 'curl -X POST http://127.0.0.1:9/x' })).toBe(
      'curl -X POST http://127.0.0.1:9/x',
    );
    expect(claudeDenialTargetForInput('Write', { file_path: '/work/probe-write.txt' })).toBe(
      '/work/probe-write.txt',
    );
    expect(claudeDenialTargetForInput('Edit', { file_path: 'rel/a.ts' })).toBe('rel/a.ts');
    expect(claudeDenialTargetForInput('NotebookEdit', { notebook_path: '/work/n.ipynb' })).toBe(
      '/work/n.ipynb',
    );
    // Tools without a command/path input keep the tool name.
    expect(claudeDenialTargetForInput('Monitor', { command: 'ls' })).toBe('Monitor');
    expect(claudeDenialTargetForInput('mcp__agent-deck__switch_deck', {})).toBe(
      'mcp__agent-deck__switch_deck',
    );
    // Missing or misshapen input falls back to the tool name.
    for (const input of [undefined, null, 42, 'x', {}, { command: 42 }, { command: '  ' }, { file_path: '' }]) {
      expect(claudeDenialTargetForInput('Bash', input)).toBe('Bash');
      expect(claudeDenialTargetForInput('Write', input)).toBe('Write');
    }
  });

  it('gates Agent Deck MCP tools by the profile allow set and rejects other servers', () => {
    expect(decideClaudeToolCall('mcp__agent-deck__get_run', {}, CTX('readonly'))).toEqual({ decision: 'allow' });
    expect(decideClaudeToolCall('mcp__agent-deck__call_service_tool', {}, CTX('readonly'))).toEqual({ decision: 'allow' });
    const denied = decideClaudeToolCall('mcp__agent-deck__switch_deck', {}, CTX('readonly'));
    expect(denied).toMatchObject({ decision: 'deny', kind: 'client_tool' });
    expect(decideClaudeToolCall('mcp__agent-deck__bind_workspace', {}, CTX('edit'))).toEqual({ decision: 'allow' });
    expect(decideClaudeToolCall('mcp__agent-deck__start_run', {}, CTX('edit')).decision).toBe('deny');
    expect(decideClaudeToolCall('mcp__other__get_run', {}, CTX('edit')).decision).toBe('deny');
  });
});
