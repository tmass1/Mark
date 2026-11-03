#!/usr/bin/env node
// The one way to put the site live, and to see first whether it's safe to:
//   pnpm site:deploy --check          every check; nothing is built or deployed
//   pnpm site:deploy                  the checks, the tests and the build, then the deploy
//   --yes                             answers its questions where there's no terminal -- an
//                                     agent's, after Tommy has said yes in chat. Never passes a stop.
//   --live-commit <hash>              names the live commit when nothing records it
// Whoever deployed last, the live version's note says which commit it was, and
// a branch that lacks it stops here instead of taking it off the site.
// docs/deploying.md explains every step and stop.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import * as check from './deploy-check.mjs';

const usage = 'Usage: pnpm site:deploy [--check] [--yes] [--live-commit <hash>]';
const opts = { check: false, yes: false, named: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--check') opts.check = true;
  else if (argv[i] === '--yes') opts.yes = true;
  else if (argv[i] === '--live-commit' && argv[i + 1]) opts.named = argv[++i];
  else if (argv[i].startsWith('--live-commit=')) opts.named = argv[i].slice('--live-commit='.length);
  else { console.error(`Don't know ${argv[i]}.\n${usage}`); process.exit(2); }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = check.git(process.cwd(), 'rev-parse', '--show-toplevel');
const git = (...args) => check.git(root, ...args);
const wrangler = (...args) => execFileSync(join(root, 'node_modules/.bin/wrangler'), args,
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
const tail = (e, lines = 15) => String(e.stderr || e.stdout || e.message || e).trim().split('\n').slice(-lines).join('\n');
const short = commit => commit.slice(0, 7);
const subject = commit => { try { return git('log', '-1', '--format=%s', commit); } catch { return '(not in this checkout)'; } };
const say = (...lines) => console.log(lines.join('\n'));
const section = title => console.log(`\n── ${title}`);
const indent = text => text.split('\n').map(line => `  ${line}`).join('\n');

function stopWith(stops) {
  for (const stop of stops) {
    const { title, meaning, fix } = check.describe(stop);
    say('', `STOP: ${title}`, indent(meaning), `  What to do: ${fix}`);
  }
  say('', `Nothing was ${opts.check ? 'built or ' : ''}deployed.`);
  process.exit(1);
}
async function answer(question) {
  if (!process.stdin.isTTY) stopWith([{ id: 'no-terminal' }]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

const branch = (() => { try { return git('symbolic-ref', '--short', '-q', 'HEAD'); } catch { return '(no branch)'; } })();
const head = git('rev-parse', 'HEAD');
say(opts.check ? `Checking a production deploy of ${check.SITE} (nothing will be built or deployed)`
               : `Deploying ${check.SITE} to production`,
    `From ${branch} at ${short(head)} ${subject(head)}, in ${root}`);
const stops = [];

section('1. Uncommitted changes');
const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
const changes = check.sortChanges(check.parseStatus(status));
if (changes.site.length) stops.push({ id: 'uncommitted', files: changes.site });
else say('Everything the site is built from is committed.');
if (changes.other.length) say(`Not part of the site, left alone: ${changes.other.join(', ')}`);

let offline = false;
try { git('fetch', 'origin', '--quiet'); } catch { offline = true; }

section("2. What's live");
let deployment, message;
try {
  deployment = JSON.parse(wrangler('deployments', 'status', '--json'));
} catch (e) { stopWith([...stops, { id: 'cloudflare-unreachable', output: tail(e) }]); }
const one = check.oneVersion(deployment);
if (one.stop) stopWith([...stops, one.stop]);
const versionId = one.versionId;
try {
  message = JSON.parse(wrangler('versions', 'view', versionId, '--json')).annotations?.['workers/message'];
} catch (e) { stopWith([...stops, { id: 'cloudflare-unreachable', output: tail(e) }]); }
const before = JSON.parse(readFileSync(join(here, 'deploys-before-check.json'), 'utf8'));
let named = opts.named;
if (named) try { named = git('rev-parse', '--verify', '--quiet', `${named}^{commit}`); } catch { /* compared as given */ }
const live = check.liveCommit({ versionId, message, before, named });
if (live.stop) stopWith([...stops, live.stop]);
const how = { note: 'its deploy note', record: 'scripts/site/deploys-before-check.json (it predates the notes)', named: 'you, with --live-commit' }[live.how];
say(`Live version ${versionId}, deployed ${deployment.created_on.replace(/\.\d+Z$/, 'Z')}${live.branch ? ` from ${live.branch}` : ''}.`,
    `Built from ${short(live.commit)} ${subject(live.commit)}`, `Known from ${how}.`);

section('3. Work that is live');
const missing = check.missingLiveWork(root, live.commit);
if (missing) { stops.push(missing); say(`This branch is missing live work: see the stop at the end.`); }
else say(`This branch has ${short(live.commit)}, so nothing live is left out.`);

section('4. Download and Software Update');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const hereRelease = check.releaseFilesHere(root, version);
const liveRelease = await liveReleaseFiles(live.commit);
if (liveRelease === null) stopWith([...stops, { id: 'cloudflare-unreachable', output: `Couldn't reach ${check.SITE}.` }]);
say(`Live: download ${liveRelease.dmg ?? 'none'}, Software Update ${liveRelease.update ?? 'none'}.`,
    `This checkout: version ${version}, download ${hereRelease.dmg ? 'found' : 'none'}, Software Update ${hereRelease.update ? 'found' : 'none'}.`);
stops.push(...check.releaseStops(liveRelease, hereRelease));
// A deploy goes no further; a check carries on, so it reports everything at once.
if (stops.length && !opts.check) stopWith(stops);

section('5. Before going on');
const counted = (...args) => Number(git('rev-list', '--count', ...args));
const notOnMain = counted(`origin/${check.MAIN}..HEAD`);
const unpushed = counted('HEAD', '--not', '--remotes=origin');
const behindMain = counted(`HEAD..origin/${check.MAIN}`);
const asks = check.confirmations({ branch, notOnMain, unpushed, behindMain, offline, liveMissing: !!missing });
if (!asks.length) say(`On ${check.MAIN}, pushed, and up to date with GitHub.`);
for (const ask of asks) {
  say(`• ${ask}`);
  if (opts.check) continue;
  if (opts.yes) say('  Go on? yes (--yes)');
  else if (!/^y(es)?$/i.test(await answer('  Go on? (y/N) '))) stopWith([{ id: 'declined' }]);
}
if (opts.check && asks.length) say('A deploy would ask you to confirm each of these.');

section(opts.check ? '6. Tests (the build waits for a real deploy)' : '6. Tests and build');
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' } });
const tests = stops.length ? null : run('pnpm', ['test']);
if (!tests) say('Not run: the stops below come first.');
else if (tests.status !== 0) {
  const failed = { id: 'tests-failed', output: tail({ stdout: tests.stdout + tests.stderr }, 25) };
  if (!opts.check) stopWith([failed]);
  stops.push(failed);
  say('Tests failed.');
} else {
  const passed = /Tests\s+(\d+) passed/.exec(tests.stdout.replace(/\x1b\[[0-9;]*m/g, ''))?.[1];
  say(`Tests passed${passed ? `: ${passed}` : ''}.`);
}
let packed = liveRelease;
if (!opts.check) {
  const build = run('sh', ['scripts/site/pack.sh']);
  if (build.status !== 0) stopWith([{ id: 'build-failed', output: tail({ stdout: build.stdout + build.stderr }, 25) }]);
  const gone = check.pagesMissing(join(root, 'dist-site'));
  if (gone.length) stopWith([{ id: 'page-missing', pages: gone }]);
  packed = check.releaseFilesPacked(join(root, 'dist-site'), version);
  const lost = check.releaseStops(liveRelease, packed);
  if (lost.length) stopWith(lost);
  say('The site built, into dist-site/.');
}

section('7. What this deploy adds');
const adds = missing?.id === 'live-not-here' ? null : git('log', '--format=%h %s', `${live.commit}..HEAD`).split('\n').filter(Boolean);
if (!adds) say("Can't tell: the live commit isn't in this checkout.");
else if (!adds.length) say(missing ? 'Nothing that isn\'t live already, and it would take off what the stop at the end lists.'
                                   : `Nothing since the live commit: this ${opts.check ? 'would publish' : 'publishes'} ${short(head)} again.`);
else {
  say(`${check.count(adds.length, 'commit')} since ${short(live.commit)}:`);
  for (const line of adds.slice(0, 40)) say(`  ${line}`);
  if (adds.length > 40) say(`  … and ${adds.length - 40} more`);
  const siteFiles = git('diff', '--name-only', live.commit, 'HEAD').split('\n').filter(f => f && check.isBuildInput(f));
  say(`${check.count(siteFiles.length, 'file')} the site is built from ${siteFiles.length === 1 ? 'changes' : 'change'}.`);
}
const publishing = opts.check ? hereRelease : packed;
const releaseLine = [['Download', liveRelease.dmg, publishing.dmg], ['Software Update', liveRelease.update, publishing.update]]
  .map(([what, was, now]) => `${what}: ${now ?? 'none'}${was === now ? ' (as live)' : ` (live: ${was ?? 'none'})`}`).join('. ');
say(`${releaseLine}.`);

let newVersion = null;
if (!opts.check) {
  if (opts.yes) say('', 'Type deploy to put this live: deploy (--yes)');
  else if (await answer('\nType deploy to put this live: ') !== 'deploy') stopWith([{ id: 'declined' }]);

  section('8. Deploying');
  // The tests and build take a while: someone else may have deployed, or a
  // file changed, since the checks ran. Then they're checked again, from the top.
  const changed = [];
  if (git('rev-parse', 'HEAD') !== head) changed.push('this branch has a new commit');
  const now = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (check.sortChanges(check.parseStatus(now)).site.length) changed.push("files the site is built from changed and aren't committed");
  try {
    if (check.oneVersion(JSON.parse(wrangler('deployments', 'status', '--json'))).versionId !== versionId) changed.push('someone else deployed');
  } catch (e) { stopWith([{ id: 'cloudflare-unreachable', output: tail(e) }]); }
  if (changed.length) stopWith([{ id: 'changed-meanwhile', changes: changed.join('; ') }]);
  const note = check.deployNote(head, branch);
  let out;
  try { out = wrangler('deploy', '--message', note, '--tag', check.deployTag(head)); }
  catch (e) { stopWith([{ id: 'deploy-failed', output: tail(e) }]); }
  newVersion = /Current Version ID:\s*([0-9a-f-]{36})/.exec(out)?.[1] ?? null;
  say(`Uploaded as version ${newVersion ?? '(Cloudflare named none)'}, with the note "${note}".`);
}

section(opts.check ? '8. The live site as it is' : '9. Checking the live site');
const problems = [];
if (!opts.check) {
  try {
    const now = check.oneVersion(JSON.parse(wrangler('deployments', 'status', '--json')));
    const noted = now.versionId && check.readNote(JSON.parse(wrangler('versions', 'view', now.versionId, '--json')).annotations?.['workers/message']);
    if (now.versionId !== newVersion) problems.push(`Cloudflare serves ${now.versionId ?? 'more than one version'}, not ${newVersion}.`);
    else if (noted?.commit !== head) problems.push(`The live version's note doesn't name ${short(head)}.`);
  } catch (e) { problems.push(`Couldn't read the deploy back from Cloudflare: ${tail(e, 3)}`); }
  const page = sha(readFileSync(join(root, 'dist-site/index.html')));
  let served = null;
  for (let i = 0; i < 8 && served !== page; i++) {
    if (i) await new Promise(r => setTimeout(r, 2000));
    try { served = sha(Buffer.from(await (await fetch(`${check.SITE}/`, { cache: 'no-store' })).arrayBuffer())); } catch { /* again */ }
  }
  if (served !== page) problems.push(`${check.SITE}/ isn't serving the page just built.`);
}
problems.push(...await check.liveProblems({ release: packed }));
if (problems.length) for (const p of problems) say(`PROBLEM: ${p}`);
else say(`Public pages load${packed.dmg ? ', the download is there' : ''}${packed.update ? ', Software Update offers ' + packed.update : ''}, and everything that should be hidden is.`);

section('Rollback');
say(opts.check ? 'If a deploy from here went wrong, this puts the site back as it is now:'
               : `${problems.length ? 'Something above is wrong. ' : ''}To put back what was live before this deploy:`,
    `  pnpm exec wrangler rollback ${versionId} --message "Back to ${short(live.commit)}"`);

section(opts.check ? 'A deploy would remind you to' : 'To do');
const todo = ['Write a release note for what went live (release-notes/).'];
if (branch !== check.MAIN && notOnMain) todo.push(`Merge ${branch} into ${check.MAIN}: it's live, so ${check.MAIN} must have it before anyone else deploys.`);
if (unpushed) todo.push('Push, when Tommy says so.');
for (const line of todo) say(`• ${line}`);
if (stops.length) stopWith(stops);
if (opts.check) say('', `No stops: ${problems.length ? 'fix the problems above, then ' : ''}a deploy from here can go ahead.`);
if (problems.length) process.exit(1);

function sha(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

/** What the site serves now: its update's version, and the newest download
 *  among the versions it could be offering. null if the site can't be reached. */
async function liveReleaseFiles(liveCommit) {
  let update = null;
  try {
    const res = await fetch(`${check.SITE}/updates/latest.json`, { cache: 'no-store' });
    if (res.ok) update = (await res.json()).version ?? null;
  } catch { return null; }
  const candidates = new Set([update]);
  try { candidates.add(JSON.parse(git('show', `${liveCommit}:package.json`)).version); } catch { /* not here */ }
  let dmg = null;
  for (const v of candidates) {
    if (!v) continue;
    try {
      const res = await fetch(`${check.SITE}/Mark_${v}_universal.dmg`, { method: 'HEAD' });
      if (res.ok && (!dmg || check.newer(v, dmg))) dmg = v;
    } catch { /* not served */ }
  }
  return { dmg, update };
}
