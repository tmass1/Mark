import './style.css';
import { command, isTauri } from './platform';
import { notesHtml } from './notes';
import { fitWindowTo } from './fit';
import markIcon from './mark-icon.png';

/** Software Update, in the shape Mac apps have long given it: what is new, and
 *  three ways to answer -- install it now, be reminded later, or skip this
 *  version. Rust does the looking, downloading and installing; this window
 *  only says what is happening and passes the answer back. */

interface Offer { version: string; current: string; notes: string }

type View =
  | { kind: 'checking' }
  | { kind: 'offer'; offer: Offer }
  | { kind: 'downloading'; offer: Offer; done: number; total: number | null }
  | { kind: 'installing'; offer: Offer }
  | { kind: 'current'; version: string }
  | { kind: 'failed'; title: string; detail: string; retry: () => void };

const root = document.querySelector<HTMLDivElement>('#update')!;
root.className = 'update';
let view: View = { kind: 'checking' };

function render(next: View) {
  view = next;
  // What the window says, beside the icon, and the buttons, in a row of their
  // own underneath, the full width of the window.
  const [body, actions = ''] = ((): [string, string?] => {
    switch (next.kind) {
      // Cancel, as Mac apps give it, also gives checking the height of what
      // follows it -- up to date, or an update without notes -- so the window
      // does not change size when the answer comes.
      case 'checking': return [`
        <h1 class="update-title">Checking for updates…</h1>
        <div class="update-bar" role="progressbar" aria-label="Checking"><span class="indeterminate"></span></div>`, `
        <span class="push"></span><button class="cancel glassy" type="button">Cancel</button>`];
      case 'offer': return [`
        <h1 class="update-title">A new version of Mark is available</h1>
        <p class="update-sub">Mark ${escape(next.offer.version)} is ready to install. You have ${escape(next.offer.current)}.</p>
        ${next.offer.notes.trim() ? `<div class="update-notes" tabindex="0" aria-label="What's new">${notesHtml(next.offer.notes)}</div>` : ''}`, `
        <button class="skip glassy" type="button">Skip This Version</button>
        <span class="push"></span>
        <button class="later glassy" type="button">Remind Me Later</button>
        <button class="install primary" type="button">Install and Relaunch</button>`];
      case 'downloading': return [`
        <h1 class="update-title">Downloading Mark ${escape(next.offer.version)}…</h1>
        <div class="update-bar" role="progressbar" aria-label="Download"
          ${next.total ? `aria-valuemin="0" aria-valuemax="${next.total}" aria-valuenow="${next.done}"` : ''}>
          <span class="${next.total ? '' : 'indeterminate'}" style="${next.total ? `width:${Math.min(100, (next.done / next.total) * 100).toFixed(1)}%` : ''}"></span>
        </div>
        <p class="update-sub">${next.total ? `${megabytes(next.done)} of ${megabytes(next.total)}` : megabytes(next.done)}</p>`];
      case 'installing': return [`
        <h1 class="update-title">Installing Mark ${escape(next.offer.version)}…</h1>
        <div class="update-bar" role="progressbar" aria-label="Installing"><span class="indeterminate"></span></div>
        <p class="update-sub">Mark will reopen by itself in a moment.</p>`];
      case 'current': return [`
        <h1 class="update-title">You're up to date</h1>
        <p class="update-sub">Mark ${escape(next.version)} is the newest version.</p>`, `
        <span class="push"></span><button class="done primary" type="button">OK</button>`];
      case 'failed': return [`
        <h1 class="update-title">${escape(next.title)}</h1>
        <p class="update-sub">${escape(friendly(next.detail))}</p>
        <p class="update-detail">${escape(next.detail)}</p>`, `
        <span class="push"></span>
        <button class="done glassy" type="button">OK</button>
        <button class="retry primary" type="button">Try Again</button>`];
    }
  })();
  root.innerHTML = `<img class="update-icon" src="${markIcon}" alt="" /><div class="update-body">${body}</div>`
    + (actions ? `<div class="update-actions">${actions}</div>` : '');
  // Return answers with the main action: install, try again, or OK.
  (['.install', '.retry', '.done', '.cancel'].map(name => root.querySelector<HTMLButtonElement>(name)).find(Boolean))?.focus();
  void appear();
}

/** The window opens hidden, and shows itself once the first thing it says is
 *  in and the window fits it, centred at the size it will be -- rather than
 *  opening at one size and jumping to another in front of you. */
let shown = false;
async function appear() {
  if (shown || !isTauri) return;
  shown = true;
  try {
    await fit();
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const current = getCurrentWindow();
    await current.center();
    await current.show();
    await current.setFocus();
  } catch {
    // Mark shows the window itself a moment later.
  }
}

/** Plainly, what a failure means; the updater's own words go underneath. */
function friendly(detail: string): string {
  if (/request|connect|dns|timed? ?out|network|offline/i.test(detail)) return "Mark couldn't reach its update server. Check your connection, then try again.";
  if (/signature/i.test(detail)) return "The download wasn't signed by Mark's key, so it was not installed.";
  return 'Something went wrong. Trying again usually fixes it.';
}

function megabytes(bytes: number): string { return `${(bytes / 1_000_000).toFixed(1)} MB`; }

function escape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function check() {
  render({ kind: 'checking' });
  try {
    const found = await command<Offer | null>('check_for_update');
    if (found) render({ kind: 'offer', offer: found });
    else render({ kind: 'current', version: await version() });
  } catch (error) {
    render({ kind: 'failed', title: "Mark couldn't check for updates", detail: String(error), retry: () => void check() });
  }
}

async function install(offer: Offer) {
  render({ kind: 'downloading', offer, done: 0, total: null });
  try {
    // Mark reopens as the new version once this succeeds, so nothing after it runs.
    await command('install_update');
  } catch (error) {
    render({ kind: 'failed', title: "Mark couldn't install the update", detail: String(error), retry: () => void install(offer) });
  }
}

async function version(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

async function closeWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

root.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!button) return;
  if (button.classList.contains('install') && view.kind === 'offer') void install(view.offer);
  else if (button.classList.contains('skip') && view.kind === 'offer') {
    void command('skip_update', { version: view.offer.version }).finally(() => void closeWindow());
  } else if (button.classList.contains('retry') && view.kind === 'failed') view.retry();
  else if (button.classList.contains('later') || button.classList.contains('done') || button.classList.contains('cancel')) void closeWindow();
});

window.addEventListener('keydown', event => {
  // ⌘W and Escape put it away, as Remind Me Later would -- except mid-install,
  // where there is nothing to put off.
  if ((event.metaKey && event.key.toLowerCase() === 'w') || event.key === 'Escape') {
    event.preventDefault();
    if (view.kind !== 'downloading' && view.kind !== 'installing') void closeWindow();
  }
});

const fit = fitWindowTo(root);

async function init() {
  if (!isTauri) {
    // The browser preview shows what an offer looks like; nothing is installed.
    document.documentElement.classList.add('browser');
    render({ kind: 'offer', offer: { version: '0.5.0', current: '0.4.5', notes: "## What's new\n\n- **An example.** This is how release notes appear here." } });
    return;
  }
  const { listen } = await import('@tauri-apps/api/event');
  await listen<{ done: number; total: number | null }>('update-progress', event => {
    if (view.kind === 'downloading') render({ ...view, done: event.payload.done, total: event.payload.total });
  });
  await listen('update-installing', () => {
    if (view.kind === 'downloading') render({ kind: 'installing', offer: view.offer });
  });
  // Opened to check, it looks for itself. Opened because Mark's own check
  // found something, it shows what was found without asking again.
  if (!new URLSearchParams(location.search).has('check')) {
    const pending = await command<Offer | null>('pending_update').catch(() => null);
    if (pending) { render({ kind: 'offer', offer: pending }); return; }
  }
  await check();
}
void init();
