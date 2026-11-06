// The checks behind `pnpm site:deploy`: what the site is built from, which
// commit is live, and what a deploy would take off the site. Each check hands
// back stops rather than printing them, so the tests can run every one without
// Cloudflare; the few that need Git take the checkout to look in.
// docs/deploying.md explains each stop in plain words.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SITE = 'https://mark.tommymassaro.com';
export const MAIN = 'main';

// What the site is built from: the pages Vite starts at (every .html at the
// top), what they import, what public/ copies, and the files pack.sh adds.
const BUILT = ['src/', 'public/', 'demo/', 'scripts/site/pack.sh', 'scripts/site/_headers', 'scripts/site/robots.txt', 'scripts/site/sitemap.xml',
  'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'wrangler.jsonc'];
// What it certainly isn't. A tracked file in neither list counts as the site's.
const NOT_BUILT = ['docs/', 'tests/', 'mockups/', 'release-notes/', 'src-tauri/', 'brand/', 'scripts/',
  '.claude/', '.gitignore', 'playwright.config.ts'];
const listed = (list, path) => list.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p));
const atTop = (path, ext) => !path.includes('/') && path.endsWith(ext);

export const isBuildInput = path => atTop(path, '.html') || listed(BUILT, path);

/** `git status --porcelain=v1 -z`, as one entry a path; a rename is both its names. */
export function parseStatus(z) {
  const parts = z.split('\0'), entries = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const xy = parts[i].slice(0, 2);
    entries.push({ path: parts[i].slice(3), untracked: xy === '??' });
    if (xy[0] === 'R' || xy[0] === 'C') entries.push({ path: parts[++i], untracked: false });
  }
  return entries;
}

/** Splits uncommitted changes into the site's and the rest. Better a needless
 *  stop over a tracked file nobody listed than a deploy of something nobody
 *  committed; an untracked file outside the site's folders -- a zip dropped in
 *  the checkout -- is left alone. */
export function sortChanges(entries) {
  const site = [], other = [];
  for (const { path, untracked } of entries) {
    const theSites = isBuildInput(path) || (!untracked && !atTop(path, '.md') && !listed(NOT_BUILT, path));
    (theSites ? site : other).push(path);
  }
  return { site, other };
}

// The note each deploy carries, on the version itself, so a rollback brings
// its note back with it. Cloudflare keeps 100 characters of message, 25 of tag.
const NOTE = /^mark-deploy commit=([0-9a-f]{40}) branch=(.*)$/;
export function deployNote(commit, branch) {
  const head = `mark-deploy commit=${commit} branch=`, room = 100 - head.length;
  return head + (branch.length > room ? `${branch.slice(0, room - 1)}…` : branch);
}
export const deployTag = commit => commit.slice(0, 12);
export function readNote(message) {
  const m = NOTE.exec(message ?? '');
  return m ? { commit: m[1], branch: m[2] } : null;
}

/** Which commit the live version was built from: its own note, else the record
 *  kept for versions deployed before notes, else a commit named by hand. A
 *  commit named by hand never overrules what's recorded. */
export function liveCommit({ versionId, message, before = {}, named }) {
  const note = readNote(message), recorded = note?.commit ?? before[versionId]?.commit;
  if (recorded) {
    if (named && !recorded.startsWith(named)) return { stop: { id: 'named-disagrees', named, recorded } };
    return { commit: recorded, how: note ? 'note' : 'record', branch: note?.branch };
  }
  if (named) return { commit: named, how: 'named' };
  return { stop: { id: 'live-unknown', versionId } };
}

/** The live site must be one version, all of it. */
export function oneVersion(status) {
  const versions = status?.versions ?? [];
  if (versions.length === 1 && versions[0].percentage === 100) return { versionId: versions[0].version_id };
  return { stop: { id: 'split-traffic', versions: versions.map(v => `${v.version_id} (${v.percentage}%)`) } };
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitOk = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };

/** A stop when this checkout would take live work off the site: the live
 *  commit has to be in it, and in what's being deployed. */
export function missingLiveWork(cwd, live, head = 'HEAD') {
  if (!gitOk(cwd, 'cat-file', '-e', `${live}^{commit}`)) return { id: 'live-not-here', live };
  if (gitOk(cwd, 'merge-base', '--is-ancestor', live, head)) return null;
  const lost = git(cwd, 'log', '--format=%h %s', `${head}..${live}`).split('\n').filter(Boolean);
  const holders = git(cwd, 'branch', '-a', '--contains', live, '--format=%(refname:short)')
    .split('\n').filter(b => b && !/(^|\/)HEAD$/.test(b) && b !== 'origin');
  holders.sort((a, b) => rank(a) - rank(b));
  return { id: 'missing-live-work', live, lost, holders };
}
const rank = b => (b === `origin/${MAIN}` ? 0 : b === MAIN ? 1 : b.startsWith('origin/') ? 2 : 3);

/** Who asks before going on: a branch other than main, commits not on GitHub,
 *  and GitHub's main ahead of this branch. None of them takes work off the site
 *  -- that's a stop, and when there is one, GitHub's extra commits may be live. */
export function confirmations({ branch, notOnMain, unpushed, behindMain, offline, liveMissing }) {
  const asks = [];
  if (offline) asks.push("Couldn't reach GitHub, so this compares with what the checkout last fetched.");
  if (branch !== MAIN) {
    asks.push(notOnMain
      ? `You're deploying from ${branch}, not ${MAIN}, and ${count(notOnMain, 'commit')} here ${notOnMain === 1 ? "isn't" : "aren't"} on ${MAIN} yet. Merge it into ${MAIN} afterwards.`
      : `You're deploying from ${branch}, not ${MAIN}. Every commit here is already on ${MAIN}, so there's nothing to merge afterwards.`);
  }
  if (unpushed) asks.push(`${count(unpushed, 'commit')} here ${unpushed === 1 ? "isn't" : "aren't"} on GitHub yet. Until ${unpushed === 1 ? "it's" : "they're"} pushed, the live site's source exists only on this Mac.`);
  if (behindMain) {
    const them = behindMain === 1 ? 'it' : 'them';
    asks.push(`GitHub's ${MAIN} has ${count(behindMain, 'commit')} this branch doesn't. ${liveMissing
      ? `This deploy would leave ${them} out, and the stop below lists what of ${them} is live.`
      : `${behindMain === 1 ? "It isn't" : "They aren't"} live, so nothing comes off the site, but this deploy leaves ${them} out.`}`);
  }
  return asks;
}
export const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The download and Software Update aren't in Git: a deploy carries whatever
 *  this checkout has, found where pack.sh looks for it. */
export const BUNDLE = 'src-tauri/target/universal-apple-darwin/release/bundle';
export function releaseFilesHere(root, version) {
  const dmg = `Mark_${version}_universal.dmg`;
  const hasDmg = [dmg, `${BUNDLE}/dmg/${dmg}`].some(p => existsSync(join(root, p)));
  let update = null;
  try {
    const manifest = JSON.parse(readFileSync(join(root, BUNDLE, 'updates/latest.json'), 'utf8'));
    if (manifest.version === version && existsSync(join(root, BUNDLE, `updates/Mark_${version}.app.tar.gz`))) update = version;
  } catch { /* none built here */ }
  return { version, dmg: hasDmg ? version : null, update };
}
/** The same, in a packed dist-site/. */
export function releaseFilesPacked(dir, version) {
  let update = null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'updates/latest.json'), 'utf8'));
    if (manifest.version === version && existsSync(join(dir, `updates/Mark_${version}.app.tar.gz`))) update = version;
  } catch { /* none packed */ }
  return { version, dmg: existsSync(join(dir, `Mark_${version}_universal.dmg`)) ? version : null, update };
}

export function newer(a, b) {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Stops when the deploy would take the download or Software Update off the
 *  site, or put an older one in place of what's live. live: { dmg, update },
 *  each the version served or null. */
export function releaseStops(live, here) {
  const stops = [];
  const best = [live.dmg, live.update].filter(Boolean).reduce((a, b) => (newer(b, a) ? b : a), '0');
  if (newer(best, here.version)) stops.push({ id: 'older-release', live: best, here: here.version });
  else {
    if (live.dmg && !here.dmg) stops.push({ id: 'no-download', live: live.dmg, here: here.version });
    if (live.update && !here.update) stops.push({ id: 'no-update', live: live.update, here: here.version });
  }
  return stops;
}

// What's checked on the live site, before and after: pages that must load,
// release files that must be there, and paths that must stay hidden. The site
// has no sign-in, so nothing on it is private beyond what's never uploaded.
export const PUBLIC_PAGES = ['/', '/ai', '/privacy', '/terms', '/demo', '/demo/editor', '/demo/selector', '/demo/recording'];

/** Public pages the build in `dir` doesn't have, so that would answer "not
 *  found" once it is live. Cloudflare serves /demo/editor from
 *  demo/editor.html, and / from index.html. */
export function pagesMissing(dir) {
  return PUBLIC_PAGES.filter(page => !existsSync(join(dir, page === '/' ? 'index.html' : `${page.slice(1)}.html`)));
}
export const HIDDEN = ['/.git/config', '/.git/HEAD', '/.env', '/.dev.vars', '/wrangler.jsonc', '/package.json',
  '/pnpm-lock.yaml', '/vite.config.ts', '/src/main.ts', '/src-tauri/tauri.conf.json', '/scripts/release.sh',
  '/selector.html', '/settings.html', '/update.html', '/thumbnail.html', '/recording.html', '/dist-site/index.html'];

/** Problems with the live site; none is the answer we want. `fetch` is
 *  injected so the tests can stand in for the network. */
export async function liveProblems({ fetch: get = fetch, release = {} } = {}) {
  const problems = [];
  const status = async (path, method = 'GET') => {
    try { return (await get(SITE + path, { method, redirect: 'follow' })).status; } catch { return 0; }
  };
  for (const path of PUBLIC_PAGES) {
    const s = await status(path);
    if (s !== 200) problems.push(`${path} should load, but answered ${s || 'nothing'}.`);
  }
  if (release.update) {
    for (const path of ['/updates/latest.json', '/updates/latest-with-notes.json']) {
      try {
        const res = await get(SITE + path, { redirect: 'follow' });
        const version = res.status === 200 ? (await res.json()).version : null;
        if (version !== release.update) problems.push(`${path} should offer ${release.update}, but ${version ? `offers ${version}` : `answered ${res.status}`}.`);
      } catch { problems.push(`${path} should offer ${release.update}, but couldn't be read.`); }
    }
  }
  if (release.dmg) {
    const path = `/Mark_${release.dmg}_universal.dmg`, s = await status(path, 'HEAD');
    if (s !== 200) problems.push(`The download ${path} should be there, but answered ${s || 'nothing'}.`);
  }
  for (const path of HIDDEN) {
    const s = await status(path);
    if (s === 0) problems.push(`${path} should stay hidden; couldn't check it.`);
    else if (s < 400) problems.push(`${path} should stay hidden, but answered ${s}.`);
  }
  return problems;
}

/** What each stop says. {name} is filled from the stop. */
export const STOPS = {
  uncommitted: {
    title: "Changes that aren't committed",
    meaning: "These files feed the site but aren't committed, so the live site wouldn't match any commit and nobody could rebuild or fix it from Git:\n{files}",
    fix: 'Commit them (or undo them), then run this again.',
  },
  'cloudflare-unreachable': {
    title: "Couldn't ask Cloudflare what's live",
    meaning: "Without knowing what's live, there's no telling what this deploy would take off the site.\n{output}",
    fix: "Check the connection. If Wrangler isn't installed in this checkout, run `pnpm install --frozen-lockfile`; if Cloudflare asks you to sign in, run `pnpm exec wrangler login`. Then run this again.",
  },
  'split-traffic': {
    title: 'The site is split between versions',
    meaning: 'Visitors are being sent to more than one version: {versions}.',
    fix: 'Finish or undo that rollout in the Cloudflare dashboard (Workers → mark → Deployments) first.',
  },
  'live-unknown': {
    title: "Can't tell which commit is live",
    meaning: 'The live version ({versionId}) has no note saying which commit it was built from, and it predates the notes.',
    fix: "Find out which commit it was: ask whoever deployed it, or follow \"Naming the live commit by hand\" in docs/deploying.md. Then run this again with `--live-commit <hash>`.",
  },
  'named-disagrees': {
    title: "The commit you named isn't the one that's live",
    meaning: 'You named {named}, but the live version is recorded as {recorded}.',
    fix: 'Leave out `--live-commit`; the recorded commit is the one that counts.',
  },
  'live-not-here': {
    title: 'This checkout has never seen the live commit',
    meaning: "The site was deployed from {live}, which isn't anywhere in this checkout, so there's no telling what this deploy would take away.",
    fix: 'Whoever deployed it pushes it to GitHub. Then run `git fetch origin`, merge the branch that has it, and run this again.',
  },
  'missing-live-work': {
    title: "This branch is missing work that's live",
    meaning: "The site was deployed from {live}, and this branch doesn't have it. Deploying now would take these off the site:\n{lost}",
    fix: 'Merge {holder} into this branch, run the checks, then run this again.',
  },
  'older-release': {
    title: 'This would put an older Mark on the site',
    meaning: 'The site offers Mark {live}, but this checkout is version {here}.',
    fix: "Deploy from a checkout that's up to date with main.",
  },
  'no-download': {
    title: 'The download would disappear',
    meaning: "The site offers Mark {live} to download, but this checkout has no download for version {here}. The disk image isn't in Git; it's left in the checkout that ran release.sh.",
    fix: "Copy that version's dmg/ folder into this checkout's src-tauri/target/universal-apple-darwin/release/bundle/, or deploy from the checkout that made the release. If the version was raised before releasing, release first.",
  },
  'no-update': {
    title: 'Software Update would lose its update',
    meaning: "The site offers Mark {live} through Software Update, but this checkout has no update files for version {here}. They aren't in Git either.",
    fix: "Copy that version's updates/ folder into this checkout's src-tauri/target/universal-apple-darwin/release/bundle/, or deploy from the checkout that made the release.",
  },
  'tests-failed': {
    title: 'The tests failed',
    meaning: '{output}',
    fix: 'Fix what failed, commit, then run this again.',
  },
  'build-failed': {
    title: "The site didn't build",
    meaning: '{output}',
    fix: 'Fix the build, commit, then run this again.',
  },
  'page-missing': {
    title: "A public page isn't in the build",
    meaning: '{pages} would answer "not found" once this is live.',
    fix: 'If it was taken out on purpose, take it off PUBLIC_PAGES in scripts/site/deploy-check.mjs and the list in docs/deploying.md, commit, then run this again. If not, find out why the build left it out.',
  },
  'no-terminal': {
    title: 'Nobody here to answer',
    meaning: "The deploy has to ask before going on, and there's no terminal to ask in.",
    fix: 'Run it in a terminal. An agent adds `--yes` only after Tommy has said yes in chat.',
  },
  declined: {
    title: 'Stopped at your answer',
    meaning: 'Nothing was deployed.',
    fix: 'Run it again when you want to go ahead.',
  },
  'changed-meanwhile': {
    title: 'Something changed while the checks ran',
    meaning: 'Before uploading, it looked again: {changes}. What was checked is no longer what would go live.',
    fix: 'Run it again, so everything is checked as it is now.',
  },
  'deploy-failed': {
    title: "Cloudflare didn't take the deploy",
    meaning: '{output}',
    fix: "The live site is as it was. Fix what Cloudflare reports, then run this again.",
  },
};

export function describe(stop) {
  const entry = STOPS[stop.id];
  const fill = text => text.replace(/\{(\w+)\}/g, (_, key) => {
    if (key === 'files') return stop.files.map(f => `  ${f}`).join('\n');
    if (key === 'lost') return stop.lost.map(c => `  ${c}`).join('\n');
    if (key === 'holder') return stop.holders?.[0] ?? 'the branch that has it';
    if (key === 'versions') return stop.versions.join(', ');
    if (key === 'pages') return stop.pages.join(', ');
    const value = String(stop[key] ?? '');
    return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value;
  });
  return { title: entry.title, meaning: fill(entry.meaning), fix: fill(entry.fix) };
}
