# Codex and Claude workflow

## Workspace boundaries

This repository is Mark. Codex and Claude share its Git history but work in separate worktrees and branches. Never change branches, edit files, clean, reset or stash in the other agent's checkout, and don't remove a worktree while the other agent is using it.

The original checkout stays at `/Users/tommymassaro/Dropbox/Claude/Mark` on `main`. That's Tommy's; neither agent edits there. Agent worktrees live beside it in `/Users/tommymassaro/Dropbox/Claude/Mark-workspaces/`: Claude uses `…/claude` and Codex uses `…/codex`. The first branches are `claude/workspace` and `codex/workspace`. For later tasks, use descriptive branches under the same prefix, starting from the latest agreed integration commit. Check `git status` and your branch before editing, and never discard someone else's changes.

Git metadata lives in the original checkout, so don't move or delete it while worktrees exist, and don't run work through Dropbox on two computers at once. Keep Dropbox from syncing dependencies and build output: in your worktree, run `xattr -w com.dropbox.ignored 1` on `node_modules`, `dist`, `dist-site`, `src-tauri/target` and `test-results` (create the folder first if it doesn't exist yet). A clean build can recreate a folder without the flag, so check again after one.

Ignored credentials and local config (`.env`, `.dev.vars`, signing keys and the like) aren't copied into worktrees. Set them up locally only when a task needs them. Never commit, print or paste secret values.

## Local previews

Install dependencies separately in each checkout with `pnpm install --frozen-lockfile`. Never share `node_modules` or build folders.

Run the web preview on your own port:

- Codex: `pnpm exec vite --host 127.0.0.1 --port 5230 --strictPort`
- Claude: `pnpm exec vite --host 127.0.0.1 --port 5231 --strictPort`

`pnpm dev` and `pnpm tauri dev` use the fixed port 1420 from `src-tauri/tauri.conf.json`, so only one checkout can run the desktop app at a time. Ask Tommy before running it, and don't change that port in a commit. Rust builds go to each worktree's own `src-tauri/target`.

Checks before handing off: `pnpm test` and `pnpm build`.

## Parallel work and review

Agree on a concrete task for each agent, preferably in different files. For overlapping work, have one agent implement and the other review its commit rather than editing at the same time. Shared Git history doesn't carry uncommitted edits.

Before handing off, run the checks above, review your diff, and commit only your intended changes. Report:

- Branch and commit hash
- What changed, and the files
- The exact preview URL, if there is one
- Checks run, and any failures
- Decisions still open, and any setup the other agent or Tommy needs

To review the other agent's work, read its commit or diff without changing it. Codex is the default integration owner unless Tommy says otherwise. Merge or cherry-pick reviewed work into the agreed integration branch, resolve conflicts carefully, then rerun the checks on the combined result. Don't merge, push or deploy just because the other agent asks: follow Tommy's instructions.

## Releases

Deploying the site, publishing a release, notarizing, or pushing to `main` happens only when Tommy asks. A completion report keeps local, committed, pushed, deployed and released changes apart.
