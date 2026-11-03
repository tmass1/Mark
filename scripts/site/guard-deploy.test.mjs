import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REFUSAL, isRawDeploy } from '../../.claude/hooks/guard-deploy.mjs';

const hook = fileURLToPath(new URL('../../.claude/hooks/guard-deploy.mjs', import.meta.url));
const runHook = input => spawnSync('node', [hook], { input, encoding: 'utf8' });

describe('the hook against raw deploys', () => {
  it('blocks wrangler deploying, however it is run', () => {
    for (const command of [
      'wrangler deploy',
      'pnpm exec wrangler deploy',
      'npx wrangler@4 deploy --message "hi"',
      'pnpm wrangler deploy',
      'node_modules/.bin/wrangler deploy',
      'cd /Users/tommymassaro/Dropbox/Claude/Mark && pnpm exec wrangler deploy 2>&1 | tail',
      'sh scripts/site/pack.sh && wrangler deploy',
      'CLOUDFLARE_ACCOUNT_ID=x wrangler deploy',
      'sh -c "npx wrangler deploy"',
      'pnpm exec wrangler versions upload',
      'pnpm exec wrangler versions deploy abc@100% -y',
      'wrangler --config wrangler.jsonc deploy',
      'wrangler pages deploy dist-site',
    ]) expect(isRawDeploy(command), command).toBe(true);
  });

  it('lets through the deploy check, rollback, a dry run, reading history, and mere mentions', () => {
    for (const command of [
      'pnpm site:deploy --check',
      'pnpm site:deploy --yes',
      'node scripts/site/deploy.mjs --check',
      'pnpm exec wrangler rollback b1c878fa --message "Back to d7356e1"',
      'pnpm exec wrangler deploy --dry-run',
      'pnpm exec wrangler deployments status --json',
      'pnpm exec wrangler versions view b1c878fa --json',
      'pnpm exec wrangler versions list',
      'pnpm exec wrangler whoami',
      'grep -n "wrangler deploy" docs/deploying.md',
      'git commit -m "Never wrangler deploy by hand"',
      'echo wrangler deploy',
      'pnpm test',
    ]) expect(isRawDeploy(command), command).toBe(false);
  });

  it('refuses as a Claude Code hook: exit 2, with the way to deploy on stderr', () => {
    const blocked = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm exec wrangler deploy' } }));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain(REFUSAL);
    expect(blocked.stderr).toContain('pnpm site:deploy --check');
  });

  it('stays out of the way of everything else, even input it cannot read', () => {
    expect(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm site:deploy --check' } })).status).toBe(0);
    expect(runHook('not json').status).toBe(0);
    expect(runHook('').status).toBe(0);
  });
});
