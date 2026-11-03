# Deploying the site

The site, mark.tommymassaro.com, has one target: production. There's no staging copy. It's hosted on Cloudflare, on Tommy's personal account, and nothing deploys it automatically: no GitHub Actions, no Cloudflare builds connected to GitHub, no Pages project. It changes only when someone runs a deploy on a Mac.

A deploy replaces the whole site with what's in the checkout it runs from. So a deploy from a branch, checkout or computer that's missing work already live takes that work off the site, without any warning. The deploy command exists to stop that.

## The command

```
pnpm site:deploy --check     # every check, without building or deploying anything
pnpm site:deploy             # the checks, the tests and the build, then the deploy
```

Always run `--check` first. Agents show Tommy its whole output before going further.

Two options:

- `--yes` answers the deploy's questions, for an agent with no terminal to type in. An agent uses it only after Tommy has said yes in chat to that deploy. It never gets past a stop.
- `--live-commit <hash>` names the live commit when nothing records it (see below). It never overrules a commit that is recorded.

## What it does, step by step

1. **Uncommitted changes.** Everything the site is built from has to be committed, so the live site always matches a commit someone can rebuild. Files that aren't part of the site, such as mock-ups, notes or zips in the checkout, are listed and left alone.
2. **What's live.** It asks Cloudflare which version is live, and reads the note that each deploy leaves on its version: the commit and branch it came from. It doesn't matter who deployed last, Tommy, Claude or Codex. The note travels with the version, so after a rollback the note is still right. One version predates the notes; `scripts/site/deploys-before-check.json` records which commit it was, and how that was proven.
3. **Work that's live.** This branch has to contain the live commit. If it doesn't, the deploy would take everything since that commit off the site, so it stops.
4. **Download and Software Update.** The disk image and update files aren't in Git. They're left in whichever checkout ran `./scripts/release.sh`, usually Tommy's. It stops if this checkout would take them off the site or put an older Mark in place of the live one.
5. **Questions.** It asks before going on when:
   - you're on a branch other than `main`;
   - your commits aren't on GitHub yet;
   - GitHub's `main` has commits you don't.

   None of these takes live work off the site, so each is a question, not a stop.
6. **Tests and build.** `pnpm test`, then the production build (`scripts/site/pack.sh`). Either failing stops it, and so does a build missing one of the public pages listed in step 9, before anything is uploaded. `--check` runs the tests and skips the build.
7. **What it adds.** The commits since the live one, and the download and update it would publish. Then it waits for you to type `deploy`.
8. **Deploy**, with the note naming the commit and branch. Just before uploading, it looks once more at what's live and at this checkout, in case someone deployed or something changed while the tests and build ran.
9. **The live site.**
   - Cloudflare has to report the new version with its note, and the home page has to be the one just built.
   - The public pages have to load: `/`, `/ai`, `/demo`, `/demo/editor`, `/demo/selector` and `/demo/recording`. So do the download and both Software Update files.
   - Everything that must stay hidden has to answer "not found": Git's files, `.env`, `.dev.vars`, the config files, the source, and the app's own window pages.
   - The site has no sign-in, so it has no private pages to check.
10. **Rollback and to-dos.** It prints the command that puts the previous version back, and reminds you to:
    - write a release note;
    - merge into `main` if you deployed from another branch;
    - push when Tommy says so.

## When it stops

Every stop ends with "Nothing was deployed" and leaves the live site as it was. Never work around a stop. Fix its cause and run the command again.

| Stop | What it means | What to do |
|---|---|---|
| Changes that aren't committed | Files the site is built from have changes no commit holds. | Commit them, or undo them. |
| Couldn't ask Cloudflare what's live | No connection, or Wrangler isn't signed in. | Check the connection; run `pnpm exec wrangler login` if asked. |
| The site is split between versions | A gradual rollout is sending visitors to two versions. | Finish or undo it in the Cloudflare dashboard (Workers → mark → Deployments). |
| Can't tell which commit is live | The live version has no note and isn't in the record. | See "Naming the live commit by hand". |
| The commit you named isn't the one that's live | `--live-commit` contradicts the recorded commit. | Leave `--live-commit` out; the record counts. |
| This checkout has never seen the live commit | It was deployed from work that never reached this checkout, or wasn't pushed. | Whoever deployed it pushes it; then `git fetch origin` and merge it. |
| This branch is missing work that's live | Deploying would take the listed commits off the site. | Merge the branch it names (usually `origin/main`), run the checks, and try again. |
| This would put an older Mark on the site | This checkout's version is older than the one the site offers. | Deploy from a checkout that's up to date with `main`. |
| The download would disappear | The site offers a download this checkout doesn't have, often because the version was raised before releasing. | Copy that version's `dmg/` folder into `src-tauri/target/universal-apple-darwin/release/bundle/`, deploy from the checkout that made the release, or release first. |
| Software Update would lose its update | The same, for the `updates/` folder. | The same, for `updates/`. |
| The tests failed / The site didn't build | The output shows what failed. | Fix it, commit, and try again. |
| A public page isn't in the build | One of the pages the site must have would answer "not found" once live. | If it was taken out on purpose, take it off the list in `scripts/site/deploy-check.mjs` and here. If not, find out why the build left it out. |
| Nobody here to answer | It needs an answer and has no terminal. | Run it in a terminal. An agent adds `--yes` only after Tommy says yes in chat. |
| Stopped at your answer | You answered no, or didn't type `deploy`. | Run it again when you're ready. |
| Something changed while the checks ran | Someone deployed, a commit landed, or a file changed during the tests and build. | Run it again, so everything is checked as it is now. |
| Cloudflare didn't take the deploy | Cloudflare reported an error. | The site is most likely as it was; `--check` shows what's live. |

A **problem** is different from a stop. It means something on the live site looks wrong after the deploy, or during `--check`. The command prints the rollback command right after it.

## Rolling back

Every run prints the rollback command with the version that was live before it, for example:

```
pnpm exec wrangler rollback b1c878fa-0e9a-440e-b280-e014d2a90f22 --message "Back to d7356e1"
```

That puts the previous version back within seconds, without building anything. Its note comes back with it, so the next deploy check knows which commit is live again. Agents roll back only when Tommy asks. Afterwards, fix what went wrong on a branch and deploy again through the command.

## Naming the live commit by hand

This only matters when the live version has no note, for example after a deploy made some other way.

1. Ask whoever deployed it which commit it was.
2. If nobody knows, compare builds. Build a candidate commit from a clean copy and compare its files with the live ones. Every file matching means that's the commit. The commit before it should differ, which proves the comparison can tell them apart. That's how the first entry in `scripts/site/deploys-before-check.json` was proven.
3. Run `pnpm site:deploy --check --live-commit <hash>`.
4. Add the version and commit, with how you know, to `scripts/site/deploys-before-check.json`, so nobody has to work it out again.

## Who is protected

The command and the hook protect only checkouts that have them. Each checkout, worktree and computer that deploys needs `main` merged in after this lands.

- **Claude Code:** `.claude/settings.json` runs `.claude/hooks/guard-deploy.mjs` before every shell command. It blocks `wrangler deploy` and its relatives (`versions upload`, `versions deploy`, `pages deploy`) and points to this command. A rollback, a dry run and reading the deploy history go through.
- **Codex and any other agent:** the rule is in `AGENTS.md`.
- **People:** `pnpm site:deploy` is the protected command. Running `wrangler deploy` by hand still works and skips every check, so don't.
