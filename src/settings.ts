import './style.css';
import { command, isTauri } from './platform';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent, shortcutProblem } from './shortcut';

/** Mark's settings window: three things, each applied the moment it changes,
 *  with nothing to save. Appearance and the shortcut are Mark's own; login is
 *  read from and written to macOS, which is the only source of truth for it. */

interface Settings { appearance: 'dark' | 'light' | 'system'; shortcut: string }

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
      <button class="recorder glassy" type="button" aria-label="Capture shortcut" aria-describedby="recorder-hint"><kbd>${prettyShortcut(DEFAULT_SHORTCUT)}</kbd></button>
      <p class="pref-hint" id="recorder-hint">Click, then press the keys you want. ⌫ puts back ${prettyShortcut(DEFAULT_SHORTCUT)}.</p>
      <p class="pref-note shortcut-note" role="status" hidden></p>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">Login</h2>
    <div class="pref-control">
      <label class="check"><input class="login" type="checkbox" /> Open Mark at login</label>
      <p class="pref-note login-note" role="status" hidden></p>
    </div>
  </section>
  <p class="pref-preview" hidden>Browser preview: settings apply in the Mac app.</p>`;

const recorder = root.querySelector<HTMLButtonElement>('.recorder')!;
const recorderKey = recorder.querySelector('kbd')!;
const shortcutNote = root.querySelector<HTMLElement>('.shortcut-note')!;
const login = root.querySelector<HTMLInputElement>('.login')!;
const loginNote = root.querySelector<HTMLElement>('.login-note')!;
let current: Settings = { appearance: 'dark', shortcut: DEFAULT_SHORTCUT };
let recording = false;

function show(settings: Settings) {
  current = settings;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.segment')) {
    const active = button.dataset.appearance === settings.appearance;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
  if (!recording) recorderKey.textContent = prettyShortcut(settings.shortcut);
  placeLens();
}

function note(element: HTMLElement, text: string | null) {
  element.hidden = !text;
  element.textContent = text ?? '';
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

function startRecording() {
  recording = true;
  recorder.classList.add('recording');
  recorderKey.textContent = 'Press keys…';
  note(shortcutNote, null);
}
function stopRecording() {
  recording = false;
  recorder.classList.remove('recording');
  recorderKey.textContent = prettyShortcut(current.shortcut);
}
async function adopt(shortcut: string) {
  try {
    show(await command<Settings>('set_shortcut', { shortcut }));
    stopRecording();
  } catch (error) {
    stopRecording();
    note(shortcutNote, String(error));
  }
}

recorder.addEventListener('click', () => { if (recording) stopRecording(); else startRecording(); });
recorder.addEventListener('blur', () => { if (recording) stopRecording(); });
window.addEventListener('keydown', event => {
  if (!recording) {
    // ⌘W and Escape close the window, as they do everywhere else on the Mac.
    if ((event.metaKey && event.key.toLowerCase() === 'w') || event.key === 'Escape') { event.preventDefault(); void closeWindow(); }
    return;
  }
  event.preventDefault();
  if (event.key === 'Escape') { stopRecording(); return; }
  if (event.key === 'Backspace' || event.key === 'Delete') { void adopt(DEFAULT_SHORTCUT); return; }
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

async function closeWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

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
}
void init();
