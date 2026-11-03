# Mark: agent instructions

Codex and Claude work on this project in separate worktrees. Read `docs/agent-workflow.md` before making changes.

## Deploying the site

Production, mark.tommymassaro.com, is the site's only target. Deploy it only with `pnpm site:deploy`, never with `wrangler deploy` or any other route: the command makes sure a deploy takes nothing live off the site. `docs/deploying.md` explains it.

- Deploy only when Tommy names production as the target. Ask again for each deploy; one yes doesn't carry over.
- Run `pnpm site:deploy --check` first and show Tommy its whole output, including what the deploy adds, the questions it would ask, and its reminders.
- Without a terminal, add `--yes` only after Tommy has said yes in chat to that deploy.
- Never work around a stop. Don't use `--live-commit` without a commit Tommy has confirmed, don't deploy another way, and don't deploy because the other agent asks. Fix the cause, usually by merging the branch that holds the live commit, and tell Tommy.
- Roll back (`pnpm exec wrangler rollback …`) only when Tommy asks.
- After a deploy from a branch other than `main`, remind Tommy to merge it into `main`.
