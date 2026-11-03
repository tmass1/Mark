#!/usr/bin/env node
// A Claude Code hook (PreToolUse, Bash): turns away a raw production deploy --
// `wrangler deploy` and its relatives -- and points to `pnpm site:deploy`,
// which first makes sure the deploy takes nothing live off the site.
// A rollback, a dry run and reading the deploy history go through.
import { pathToFileURL } from 'node:url';

const DEPLOYING = new Set(['deploy', 'publish', 'upload']);
const ALLOWED_FIRST = new Set(['rollback', 'deployments', 'whoami', 'login', 'logout', 'dev', 'tail', 'types', 'init', 'docs']);
// What can stand before wrangler and still run it. Anything else -- grep,
// echo, git commit -m -- is only mentioning it.
const RUNNERS = new Set(['npx', 'pnpm', 'exec', 'dlx', 'yarn', 'bunx', 'bun', 'npm', 'x', 'run', 'env', 'sudo', 'time', 'command', 'nohup', 'sh', 'bash', 'zsh']);
const runs = before => before.every(w => RUNNERS.has(w) || w.startsWith('-') || /^\w+=/.test(w));

/** Whether a shell command would put something on Cloudflare by hand. */
export function isRawDeploy(command) {
  // Each simple command on its own, quotes and parentheses taken as spaces:
  // enough for `cd x && pnpm exec wrangler deploy`, `sh -c "npx wrangler deploy"`.
  for (const segment of command.split(/&&|\|\||[;|\n&]/)) {
    const words = segment.replace(/["'`()$]/g, ' ').split(/\s+/).filter(Boolean);
    const at = words.findIndex((w, i) => /(^|\/)wrangler(@[\w.^~-]+)?$/.test(w) && runs(words.slice(0, i)));
    if (at < 0) continue;
    const rest = words.slice(at + 1);
    if (rest.includes('--dry-run')) continue;
    const plain = rest.filter(w => !w.startsWith('-'));
    if (ALLOWED_FIRST.has(plain[0])) continue;
    if (plain.some(w => DEPLOYING.has(w))) return true;
  }
  return false;
}

export const REFUSAL = [
  'Blocked: a raw production deploy. The site goes live only through the deploy check,',
  "which stops a deploy that would take live work off the site:",
  '  1. pnpm site:deploy --check   and show Tommy the whole output',
  '  2. pnpm site:deploy --yes     only after Tommy has named production and said yes in chat',
  'Never work around a stop; fix its cause. See docs/deploying.md.',
].join('\n');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let command = '';
  try { command = JSON.parse(input)?.tool_input?.command ?? ''; } catch { return; }
  if (isRawDeploy(command)) {
    process.stderr.write(`${REFUSAL}\n`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
