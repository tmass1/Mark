import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  HIDDEN, PUBLIC_PAGES, SITE, STOPS, BUNDLE, pagesMissing, confirmations, deployNote, deployTag, describe as describeStop,
  isBuildInput, liveCommit, liveProblems, missingLiveWork, newer, oneVersion, parseStatus, readNote,
  releaseFilesHere, releaseStops, sortChanges,
} from './deploy-check.mjs';

const LIVE = 'd7356e1311f630fde995634d7437ccc3c9af6475';
const temps = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mark-deploy-')); temps.push(dir); return dir; };
afterAll(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

describe('uncommitted changes', () => {
  it('reads git status, a rename as both its names', () => {
    expect(parseStatus(' M src/main.ts\0?? mockups/a.html\0R  src/new.ts\0src/old.ts\0'))
      .toEqual([{ path: 'src/main.ts', untracked: false }, { path: 'mockups/a.html', untracked: true },
                { path: 'src/new.ts', untracked: false }, { path: 'src/old.ts', untracked: false }]);
  });

  it('stops for what the site is built from, and leaves the rest alone', () => {
    const changes = sortChanges([
      ...['src/main.ts', 'public/site/hero.png', 'site.html', 'package.json', 'scripts/site/_headers', 'demo/editor.html']
        .map(path => ({ path, untracked: false })),
      { path: 'src/brand-new.ts', untracked: true },
      ...['mockups/landing-light.html', 'mark-highlight-arrow-svg.zip', 'mark-highlight-arrow-svg/arrow.svg']
        .map(path => ({ path, untracked: true })),
      ...['docs/deploying.md', 'README.md', 'src-tauri/src/lib.rs', 'scripts/release.sh', 'tests/frame.spec.ts']
        .map(path => ({ path, untracked: false })),
    ]);
    expect(changes.site).toEqual(['src/main.ts', 'public/site/hero.png', 'site.html', 'package.json',
      'scripts/site/_headers', 'demo/editor.html', 'src/brand-new.ts']);
    expect(changes.other).toHaveLength(8);
  });

  it('counts a tracked file nobody listed as the site\'s, to be safe', () => {
    expect(sortChanges([{ path: 'shared/util.ts', untracked: false }]).site).toEqual(['shared/util.ts']);
    expect(isBuildInput('scripts/site/deploy.mjs')).toBe(false);
    expect(isBuildInput('scripts/site/pack.sh')).toBe(true);
  });
});

describe('the note on each deploy', () => {
  it('names the commit and branch, and reads back', () => {
    const note = deployNote(LIVE, 'claude/workspace');
    expect(note).toBe(`mark-deploy commit=${LIVE} branch=claude/workspace`);
    expect(readNote(note)).toEqual({ commit: LIVE, branch: 'claude/workspace' });
    expect(deployTag(LIVE)).toBe('d7356e1311f6');
  });

  it('fits in what Cloudflare keeps: 100 characters of message, 25 of tag', () => {
    const note = deployNote(LIVE, `claude/${'a-very-long-branch-name-'.repeat(4)}`);
    expect(note.length).toBeLessThanOrEqual(100);
    expect(readNote(note).commit).toBe(LIVE);
    expect(deployTag(LIVE).length).toBeLessThanOrEqual(25);
  });

  it('is nothing when a version has no note, or someone else\'s', () => {
    expect(readNote(undefined)).toBeNull();
    expect(readNote('Fixed the header')).toBeNull();
  });
});

describe('which commit is live', () => {
  const before = { 'old-version': { commit: LIVE } };

  it('is the note\'s, else the record of deploys before notes, else one named by hand', () => {
    expect(liveCommit({ versionId: 'v', message: deployNote('a'.repeat(40), 'main'), before }))
      .toEqual({ commit: 'a'.repeat(40), how: 'note', branch: 'main' });
    expect(liveCommit({ versionId: 'old-version', before })).toMatchObject({ commit: LIVE, how: 'record' });
    expect(liveCommit({ versionId: 'v', before, named: 'b'.repeat(40) })).toEqual({ commit: 'b'.repeat(40), how: 'named' });
  });

  it('stops when nothing tells, or when a commit named by hand contradicts the record', () => {
    expect(liveCommit({ versionId: 'v', before }).stop).toEqual({ id: 'live-unknown', versionId: 'v' });
    expect(liveCommit({ versionId: 'old-version', before, named: 'b'.repeat(40) }).stop.id).toBe('named-disagrees');
    expect(liveCommit({ versionId: 'old-version', before, named: 'd7356e1' }).commit).toBe(LIVE);
  });

  it('must be one version serving everyone', () => {
    expect(oneVersion({ versions: [{ version_id: 'v1', percentage: 100 }] })).toEqual({ versionId: 'v1' });
    expect(oneVersion({ versions: [{ version_id: 'v1', percentage: 60 }, { version_id: 'v2', percentage: 40 }] }).stop)
      .toEqual({ id: 'split-traffic', versions: ['v1 (60%)', 'v2 (40%)'] });
    expect(oneVersion({}).stop.id).toBe('split-traffic');
  });
});

describe('work that is live', () => {
  // main: A - B (live);  side: A - C, never given B.
  const repo = temp();
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test'); git('config', 'commit.gpgsign', 'false');
  const commit = (file, subject) => { writeFileSync(join(repo, file), subject); git('add', file); git('commit', '-q', '-m', subject); return git('rev-parse', 'HEAD'); };
  const a = commit('a.txt', 'A page');
  const b = commit('b.txt', 'The live header');
  git('switch', '-q', '-c', 'side', a);
  commit('c.txt', 'A side change');

  it('stops a branch without the live commit, naming what would come off and where to get it', () => {
    const stop = missingLiveWork(repo, b);
    expect(stop).toMatchObject({ id: 'missing-live-work', live: b, holders: ['main'] });
    expect(stop.lost).toEqual([`${b.slice(0, 7)} The live header`]);
    expect(describeStop(stop).meaning).toContain('The live header');
    expect(describeStop(stop).meaning).toContain(`deployed from ${b.slice(0, 7)},`);
    expect(describeStop(stop).fix).toBe('Merge main into this branch, run the checks, then run this again.');
  });

  it('lets through a branch that has it, on main or merged', () => {
    expect(missingLiveWork(repo, a)).toBeNull();
    git('merge', '-q', '--no-edit', 'main');
    expect(missingLiveWork(repo, b)).toBeNull();
  });

  it('stops when the live commit has never reached this checkout', () => {
    expect(missingLiveWork(repo, 'f'.repeat(40))).toEqual({ id: 'live-not-here', live: 'f'.repeat(40) });
  });
});

describe('questions before going on', () => {
  it('asks nothing on main, pushed and up to date', () => {
    expect(confirmations({ branch: 'main', notOnMain: 0, unpushed: 0, behindMain: 0 })).toEqual([]);
  });

  it('asks about another branch, saying whether it needs merging', () => {
    expect(confirmations({ branch: 'claude/workspace', notOnMain: 0 })[0]).toContain("nothing to merge afterwards");
    expect(confirmations({ branch: 'claude/x', notOnMain: 2 })[0]).toContain("2 commits here aren't on main yet. Merge it into main afterwards.");
  });

  it('asks about commits not pushed, GitHub being ahead, and GitHub being out of reach', () => {
    const asks = confirmations({ branch: 'main', unpushed: 1, behindMain: 3, offline: true });
    expect(asks).toHaveLength(3);
    expect(asks.join(' ')).toMatch(/1 commit here isn't on GitHub yet. Until it's pushed.*3 commits this branch doesn't/);
  });

  it('never calls GitHub\'s extra commits not live when live work is missing', () => {
    expect(confirmations({ branch: 'main', behindMain: 1 })[0]).toContain("It isn't live");
    expect(confirmations({ branch: 'main', behindMain: 1, liveMissing: true })[0]).not.toContain("isn't live");
  });
});

describe('the download and Software Update', () => {
  it('stops when the deploy would take either off the site', () => {
    const live = { dmg: '0.8.2', update: '0.8.2' };
    expect(releaseStops(live, { version: '0.8.2', dmg: '0.8.2', update: '0.8.2' })).toEqual([]);
    expect(releaseStops(live, { version: '0.8.2', dmg: null, update: '0.8.2' }).map(s => s.id)).toEqual(['no-download']);
    expect(releaseStops(live, { version: '0.8.2', dmg: '0.8.2', update: null }).map(s => s.id)).toEqual(['no-update']);
  });

  it('stops a version raised before its release, and an older one', () => {
    const live = { dmg: '0.8.2', update: '0.8.2' };
    expect(releaseStops(live, { version: '0.9.0', dmg: null, update: null }).map(s => s.id)).toEqual(['no-download', 'no-update']);
    expect(releaseStops(live, { version: '0.8.1', dmg: '0.8.1', update: '0.8.1' }).map(s => s.id)).toEqual(['older-release']);
    expect(releaseStops({ dmg: null, update: null }, { version: '0.9.0', dmg: null, update: null })).toEqual([]);
  });

  it('finds them where pack.sh does', () => {
    const root = temp();
    expect(releaseFilesHere(root, '0.8.2')).toEqual({ version: '0.8.2', dmg: null, update: null });
    mkdirSync(join(root, BUNDLE, 'dmg'), { recursive: true });
    mkdirSync(join(root, BUNDLE, 'updates'), { recursive: true });
    writeFileSync(join(root, BUNDLE, 'dmg/Mark_0.8.2_universal.dmg'), '');
    writeFileSync(join(root, BUNDLE, 'updates/latest.json'), JSON.stringify({ version: '0.8.2' }));
    expect(releaseFilesHere(root, '0.8.2').update).toBeNull();   // a manifest without its archive
    writeFileSync(join(root, BUNDLE, 'updates/Mark_0.8.2.app.tar.gz'), '');
    expect(releaseFilesHere(root, '0.8.2')).toEqual({ version: '0.8.2', dmg: '0.8.2', update: '0.8.2' });
    expect(releaseFilesHere(root, '0.9.0')).toEqual({ version: '0.9.0', dmg: null, update: null });
  });

  it('compares versions by number', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true);
    expect(newer('0.8.2', '0.8.2')).toBe(false);
    expect(newer('0.8.1', '0.8.2')).toBe(false);
  });
});

describe('the live site', () => {
  const site = (answers = {}) => async (url, { method } = {}) => {
    const path = url.slice(SITE.length);
    const answer = answers[path] ?? (PUBLIC_PAGES.includes(path) || path.startsWith('/Mark_') ? 200
      : path.startsWith('/updates/') ? { version: '0.8.2' } : 404);
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'object') return { status: 200, json: async () => answer };
    return { status: answer, method };
  };
  const release = { dmg: '0.8.2', update: '0.8.2' };

  it('is fine when pages load, the release is there and hidden things stay hidden', async () => {
    expect(await liveProblems({ fetch: site(), release })).toEqual([]);
  });

  it('reports a page that fails, a release that is wrong or gone, and anything hidden that shows', async () => {
    const problems = await liveProblems({ release, fetch: site({
      '/ai': 500, '/updates/latest.json': { version: '0.8.1' }, '/Mark_0.8.2_universal.dmg': 404, '/.env': 200,
    }) });
    expect(problems).toEqual([
      '/ai should load, but answered 500.',
      '/updates/latest.json should offer 0.8.2, but offers 0.8.1.',
      'The download /Mark_0.8.2_universal.dmg should be there, but answered 404.',
      '/.env should stay hidden, but answered 200.',
    ]);
  });

  it('counts a path it could not reach as a problem, not as hidden', async () => {
    const problems = await liveProblems({ fetch: site({ '/.git/config': new Error('offline') }) });
    expect(problems).toEqual(["/.git/config should stay hidden; couldn't check it."]);
    expect(HIDDEN).toContain('/wrangler.jsonc');
  });
});

describe('the pages a build has', () => {
  it('names each public page the build left out, and none it has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pages-'));
    mkdirSync(join(dir, 'demo'));
    for (const file of ['index.html', 'ai.html', 'demo.html', 'demo/editor.html']) writeFileSync(join(dir, file), '');
    expect(pagesMissing(dir)).toEqual(['/demo/selector']);
    writeFileSync(join(dir, 'demo/selector.html'), '');
    expect(pagesMissing(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

describe('what each stop says', () => {
  it('fills every blank, for every stop', () => {
    const fields = { files: ['src/main.ts'], lost: ['abc1234 A change'], holders: ['origin/main'], versions: ['v1 (50%)'],
      output: 'out', versionId: 'v', named: 'n', recorded: 'r', live: 'l', here: 'h', changes: 'someone else deployed', pages: ['/demo'] };
    for (const id of Object.keys(STOPS)) {
      const { title, meaning, fix } = describeStop({ id, ...fields });
      expect(title).toBeTruthy();
      expect(`${meaning} ${fix}`).not.toMatch(/\{\w+\}/);
    }
  });
});
