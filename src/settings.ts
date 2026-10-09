import './style.css';
import { command, isTauri } from './platform';
import { fitWindowTo } from './fit';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent, shortcutProblem } from './shortcut';

/** Mark's settings window: each thing applied the moment it changes, with
 *  nothing to save. Appearance, the shortcuts, what follows a capture, AI
 *  tools and updates are Mark's own; login is read from and written to macOS,
 *  which is the only source of truth for it. */

type Way = 'region' | 'window' | 'display' | 'timed';
interface Settings {
  appearance: 'dark' | 'light' | 'system'; shortcut: string; checkUpdates?: boolean;
  /** The other ways in; each has one only once it is chosen. */
  shortcuts?: Partial<Record<Exclude<Way, 'region'>, string>>;
  afterCapture?: 'editor' | 'thumbnail';
  mcp?: boolean;
}
/** What points an AI tool at this Mark, made by Rust from where it really is. */
interface Setup { claudeCode: string; claudeDesktop: string }

/** The four ways into a capture, each with a shortcut of its own. Capture
 *  Region always has one; the rest start without, since a key taken globally
 *  is taken from every other app. */
const WAYS: { way: Way; name: string }[] = [
  { way: 'region', name: 'Region' }, { way: 'window', name: 'Window' },
  { way: 'display', name: 'Whole Screen' }, { way: 'timed', name: 'Timed Region' },
];
const shortcutOf = (settings: Settings, way: Way) => way === 'region' ? settings.shortcut : settings.shortcuts?.[way] ?? '';

const APPEARANCES: { id: Settings['appearance']; name: string }[] = [
  { id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }, { id: 'system', name: 'Match System' },
];

const root = document.querySelector<HTMLDivElement>('#settings')!;
root.className = 'prefs';
root.innerHTML = `
  <section class="pref">
    <h2 class="pref-label">Appearance</h2>
    <div class="pref-control">
      <div class="segments" role="radiogroup" aria-label="Appearance">
        ${APPEARANCES.map(a => `<button class="segment" type="button" role="radio" aria-checked="${a.id === 'dark'}" data-appearance="${a.id}">${a.name}</button>`).join('')}
      </div>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">Capture</h2>
    <div class="pref-control">
      <div class="ways">
        ${WAYS.map(({ way, name }) => `<span class="way-name" id="way-${way}">${name}</span>
          <button class="recorder glassy" type="button" data-way="${way}" aria-labelledby="way-${way}" aria-describedby="recorder-hint"><kbd>${way === 'region' ? prettyShortcut(DEFAULT_SHORTCUT) : 'None'}</kbd></button>`).join('')}
      </div>
      <p class="pref-hint" id="recorder-hint">Click one, then press the keys you want. ⌫ clears it; Region’s goes back to ${prettyShortcut(DEFAULT_SHORTCUT)}.</p>
      <p class="pref-note shortcut-note" role="status" hidden></p>
      <label class="check"><input class="thumbnail-after" type="checkbox" aria-describedby="thumbnail-hint" /> Show a thumbnail instead of the editor</label>
      <p class="pref-hint" id="thumbnail-hint">Copied at once, it waits in the corner: click it to mark it up, or drag it into any app.</p>
      <p class="pref-note after-note" role="status" hidden></p>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">AI tools</h2>
    <div class="pref-control">
      <label class="check"><input class="mcp" type="checkbox" checked aria-describedby="mcp-hint" /> Let AI tools ask for screenshots</label>
      <p class="pref-hint" id="mcp-hint">Claude Code, Claude and other MCP apps can ask; nothing is sent until you press Send.</p>
      <div class="setup-buttons">
        <button class="copy-command glassy" type="button">Copy Claude Code Command</button>
        <button class="copy-entry glassy" type="button">Copy Claude Desktop Config</button>
      </div>
      <p class="pref-note mcp-note" role="status" hidden></p>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">Login</h2>
    <div class="pref-control">
      <label class="check"><input class="login" type="checkbox" /> Open Mark at login</label>
      <p class="pref-note login-note" role="status" hidden></p>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">Updates</h2>
    <div class="pref-control">
      <label class="check"><input class="auto-update" type="checkbox" checked /> Check for updates automatically</label>
      <button class="check-now glassy" type="button">Check Now</button>
    </div>
  </section>
  <p class="pref-preview" hidden>Browser preview: settings apply in the Mac app.</p>
  <p class="pref-version" hidden></p>`;

const recorders = [...root.querySelectorAll<HTMLButtonElement>('.recorder')];
const shortcutNote = root.querySelector<HTMLElement>('.shortcut-note')!;
const login = root.querySelector<HTMLInputElement>('.login')!;
const loginNote = root.querySelector<HTMLElement>('.login-note')!;
const autoUpdate = root.querySelector<HTMLInputElement>('.auto-update')!;
const thumbnailAfter = root.querySelector<HTMLInputElement>('.thumbnail-after')!;
const afterNote = root.querySelector<HTMLElement>('.after-note')!;
const mcp = root.querySelector<HTMLInputElement>('.mcp')!;
const mcpNote = root.querySelector<HTMLElement>('.mcp-note')!;
let current: Settings = { appearance: 'dark', shortcut: DEFAULT_SHORTCUT };
/** The recorder listening for keys, if one is. */
let recording: HTMLButtonElement | null = null;

/** What a recorder shows: its shortcut the way a Mac prints it, or None. */
function label(recorder: HTMLButtonElement) {
  const shortcut = shortcutOf(current, recorder.dataset.way as Way);
  const key = recorder.querySelector('kbd')!;
  key.textContent = shortcut ? prettyShortcut(shortcut) : 'None';
  recorder.classList.toggle('unset', !shortcut);
}

function show(settings: Settings) {
  current = settings;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.segment')) {
    const active = button.dataset.appearance === settings.appearance;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
  for (const recorder of recorders) if (recorder !== recording) label(recorder);
  autoUpdate.checked = settings.checkUpdates !== false;
  thumbnailAfter.checked = settings.afterCapture === 'thumbnail';
  mcp.checked = settings.mcp !== false;
  placeLens();
}

/** A line under a control: what went wrong, or -- `done` -- what was done. */
function note(element: HTMLElement, text: string | null, done = false) {
  element.hidden = !text;
  element.textContent = text ?? '';
  element.classList.toggle('done', done);
}

/** The same sliding pill as the editor's pickers, under the chosen appearance. */
function placeLens() {
  const group = root.querySelector<HTMLElement>('.segments')!;
  let lens = group.querySelector<HTMLElement>(':scope > .lens');
  if (!lens) { lens = document.createElement('span'); lens.className = 'lens'; group.prepend(lens); }
  const active = group.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!active || active.offsetParent === null) { lens.hidden = true; return; }
  const snap = lens.dataset.placed === undefined;
  lens.hidden = false;
  if (snap) lens.style.transition = 'none';
  lens.style.width = `${active.offsetWidth}px`; lens.style.height = `${active.offsetHeight}px`;
  lens.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (snap) { void lens.offsetWidth; lens.style.transition = ''; lens.dataset.placed = ''; }
}

root.addEventListener('click', event => {
  const segment = (event.target as Element).closest<HTMLButtonElement>('.segment');
  if (segment?.dataset.appearance) {
    void command<Settings>('set_appearance', { appearance: segment.dataset.appearance }).then(show).catch(() => {});
  }
});

function startRecording(recorder: HTMLButtonElement) {
  if (recording) stopRecording();
  recording = recorder;
  recorder.classList.add('recording');
  recorder.querySelector('kbd')!.textContent = 'Press keys…';
  note(shortcutNote, null);
}
function stopRecording() {
  const was = recording;
  recording = null;
  if (!was) return;
  was.classList.remove('recording');
  label(was);
}
/** Capture Region's goes as it always has, with no way named; the others say
 *  which they are. An empty shortcut clears one. */
async function adopt(shortcut: string) {
  const way = recording?.dataset.way as Way | undefined;
  if (!way) return;
  try {
    show(await command<Settings>('set_shortcut', way === 'region' ? { shortcut } : { shortcut, mode: way }));
    stopRecording();
  } catch (error) {
    stopRecording();
    note(shortcutNote, String(error));
  }
}

for (const recorder of recorders) {
  recorder.addEventListener('click', () => { if (recording === recorder) stopRecording(); else startRecording(recorder); });
  recorder.addEventListener('blur', () => { if (recording === recorder) stopRecording(); });
}
window.addEventListener('keydown', event => {
  if (!recording) {
    // ⌘W and Escape close the window, as they do everywhere else on the Mac.
    if ((event.metaKey && event.key.toLowerCase() === 'w') || event.key === 'Escape') { event.preventDefault(); void closeWindow(); }
    return;
  }
  event.preventDefault();
  if (event.key === 'Escape') { stopRecording(); return; }
  if (event.key === 'Backspace' || event.key === 'Delete') { void adopt(recording.dataset.way === 'region' ? DEFAULT_SHORTCUT : ''); return; }
  const problem = shortcutProblem(event);
  if (problem) { if (!/then press a key/.test(problem)) note(shortcutNote, problem); return; }
  void adopt(shortcutFromEvent(event)!);
});

login.addEventListener('change', async () => {
  note(loginNote, null);
  try {
    login.checked = await command<boolean>('set_login', { enabled: login.checked });
  } catch (error) {
    note(loginNote, String(error));
    login.checked = await command<boolean>('login_enabled').catch(() => false);
  }
});

thumbnailAfter.addEventListener('change', () => {
  note(afterNote, null);
  void command<Settings>('set_after_capture', { value: thumbnailAfter.checked ? 'thumbnail' : 'editor' }).then(show)
    .catch(error => { note(afterNote, String(error)); thumbnailAfter.checked = current.afterCapture === 'thumbnail'; });
});

mcp.addEventListener('change', () => {
  note(mcpNote, null);
  void command<Settings>('set_mcp', { enabled: mcp.checked }).then(show)
    .catch(error => { note(mcpNote, String(error)); mcp.checked = current.mcp !== false; });
});

/** Copy what points a tool at this Mark, and say where it goes. */
async function copySetup(which: keyof Setup, where: string) {
  note(mcpNote, null);
  try {
    const setup = await command<Setup>('mcp_setup');
    await command('copy_text', { text: setup[which] });
    note(mcpNote, where, true);
  } catch (error) { note(mcpNote, String(error)); }
}
root.querySelector<HTMLButtonElement>('.copy-command')!.addEventListener('click', () => {
  void copySetup('claudeCode', 'Copied. Paste it into Terminal and press Return; Claude Code can then ask in any project.');
});
root.querySelector<HTMLButtonElement>('.copy-entry')!.addEventListener('click', () => {
  void copySetup('claudeDesktop', 'Copied. Add it to claude_desktop_config.json, in Library/Application Support/Claude, then quit and reopen Claude.');
});

autoUpdate.addEventListener('change', () => {
  void command<Settings>('set_auto_update', { enabled: autoUpdate.checked }).then(show)
    .catch(() => { autoUpdate.checked = current.checkUpdates !== false; });
});
root.querySelector<HTMLButtonElement>('.check-now')!.addEventListener('click', () => {
  void command('open_updates').catch(() => {});
});

async function closeWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

fitWindowTo(root);

async function init() {
  if (!isTauri) {
    root.querySelector<HTMLElement>('.pref-preview')!.hidden = false;
    document.documentElement.classList.add('browser');
    show(current);
    return;
  }
  const [settings, enabled] = await Promise.all([command<Settings>('get_settings'), command<boolean>('login_enabled')]);
  show(settings);
  login.checked = enabled;
  // The first thing anyone testing a build is asked is which build.
  const { getVersion } = await import('@tauri-apps/api/app');
  const version = root.querySelector<HTMLElement>('.pref-version')!;
  version.textContent = `Mark ${await getVersion()}`;
  version.hidden = false;
}
void init();
