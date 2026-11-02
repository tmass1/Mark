import './style.css';
import { command, isTauri } from './platform';
import { fitWindowTo } from './fit';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent, shortcutProblem } from './shortcut';
import { CLICKS, POINTERS, lookOf, type ClickLook, type PointerLook } from './look';

/** Mark's settings window: each thing applied the moment it changes, with
 *  nothing to save. Appearance, the shortcuts, what follows a capture, AI
 *  tools and updates are Mark's own; login is read from and written to macOS,
 *  which is the only source of truth for it. */

type Way = 'region' | 'window' | 'display' | 'timed' | 'record';
interface Settings {
  appearance: 'dark' | 'light' | 'system'; shortcut: string; checkUpdates?: boolean; installUpdates?: boolean;
  /** The other ways in; each has one only once it is chosen. */
  shortcuts?: Partial<Record<Exclude<Way, 'region'>, string>>;
  afterCapture?: 'editor' | 'thumbnail';
  mcp?: boolean;
  /** Whether a recording takes in the microphone, and how it shows the
   *  pointer and clicks. */
  recordMic?: boolean;
  recordingPointer?: PointerLook;
  recordingClicks?: ClickLook;
  /** Whether a recording opens with zooms round its clicks. */
  recordZoom?: boolean;
  /** Whether Mark is in the Dock, or in the menu bar alone. */
  showInDock?: boolean;
}
/** One AI tool Mark can be added to, and how -- made by Rust for the copy of
 *  Mark that is running, so what is copied starts this very copy. */
interface Agent {
  name: string; group: string;
  kind: 'command' | 'link' | 'config' | 'form';
  text?: string; url?: string; place?: string; restart?: boolean; steps?: string;
  /** Which of the tool's agents it is for, where that is easily mistaken. */
  hint?: string;
}

/** The ways into a capture, each with a shortcut of its own. Capture Region
 *  always has one; the rest start without, since a key taken globally is
 *  taken from every other app. Record Video shows only on a Mac that can
 *  record: macOS 15 or later. */
const WAYS: { way: Way; name: string }[] = [
  { way: 'region', name: 'Region' }, { way: 'window', name: 'Window' },
  { way: 'display', name: 'Whole Screen' }, { way: 'timed', name: 'Timed Region' }, { way: 'record', name: 'Record Video' },
];
const shortcutOf = (settings: Settings, way: Way) => way === 'region' ? settings.shortcut : settings.shortcuts?.[way] ?? '';

/** The ▾ in a pill that opens a list. */
const CHEVRON = '<svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.6 8.4 10 11.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
        ${WAYS.map(({ way, name }) => `<span class="way-name" id="way-${way}"${way === 'record' ? ' data-records hidden' : ''}>${name}</span>
          <button class="recorder glassy" type="button" data-way="${way}" aria-labelledby="way-${way}" aria-describedby="recorder-hint"${way === 'record' ? ' data-records hidden' : ''}><kbd>${way === 'region' ? prettyShortcut(DEFAULT_SHORTCUT) : 'None'}</kbd></button>`).join('')}
      </div>
      <p class="pref-hint" id="recorder-hint">Click one, then press the keys you want. ⌫ clears it; Region’s goes back to ${prettyShortcut(DEFAULT_SHORTCUT)}.</p>
      <p class="pref-note shortcut-note" role="status" hidden></p>
      <label class="check"><input class="thumbnail-after" type="checkbox" aria-describedby="thumbnail-hint" /> Show a thumbnail instead of the editor</label>
      <p class="pref-hint" id="thumbnail-hint">Copied at once, it waits in the corner: click it to mark it up, or drag it into any app.</p>
      <p class="pref-note after-note" role="status" hidden></p>
    </div>
  </section>
  <section class="pref" data-records hidden>
    <h2 class="pref-label">Recording</h2>
    <div class="pref-control">
      <label class="check"><input class="record-mic" type="checkbox" aria-describedby="record-mic-hint" /> Record the microphone too</label>
      <p class="pref-hint" id="record-mic-hint">macOS asks the first time. The microphone button beside Record turns it on and off too.</p>
      <div class="look-picks">
        <label class="look-pick">Pointer <span class="agent-pick"><select class="record-pointer pill-select" aria-describedby="record-look-hint">
          ${POINTERS.map(choice => `<option value="${choice.id}">${choice.name}</option>`).join('')}</select>${CHEVRON}</span></label>
        <label class="look-pick">Clicks <span class="agent-pick"><select class="record-clicks pill-select" aria-describedby="record-look-hint">
          ${CLICKS.map(choice => `<option value="${choice.id}">${choice.name}</option>`).join('')}</select>${CHEVRON}</span></label>
      </div>
      <p class="pref-hint" id="record-look-hint">Touch shows a fingertip, for a phone prototype; Halo a soft glow round the arrow. The bar beside Record changes them too, and the editor changes Halo, Touch and Ripple afterwards.</p>
      <label class="check"><input class="record-zoom" type="checkbox" aria-describedby="record-zoom-hint" /> Zoom in on clicks</label>
      <p class="pref-hint" id="record-zoom-hint">A recording opens with the picture moving in gently round each burst of clicks. The bar beside Record turns it on and off too, and the editor changes or removes each zoom.</p>
      <p class="pref-note record-note" role="status" hidden></p>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">AI tools</h2>
    <div class="pref-control">
      <label class="check"><input class="mcp" type="checkbox" checked aria-describedby="mcp-hint" /> Let AI tools ask for screenshots</label>
      <p class="pref-hint" id="mcp-hint">Claude, ChatGPT, Cursor, Copilot and other AI tools can ask; nothing is sent until you press Send.</p>
      <span class="add-label" id="agent-label">Add Mark to</span>
      <div class="add-to">
        <span class="agent-pick"><select class="agent" aria-labelledby="agent-label" disabled></select>
          ${CHEVRON}</span>
        <button class="add-agent glassy" type="button" disabled>Copy Command</button>
      </div>
      <p class="pref-hint agent-hint" hidden></p>
      <p class="pref-note mcp-note" role="status" hidden></p>
      <button class="guide" type="button">How to set it up and use it</button>
    </div>
  </section>
  <section class="pref">
    <h2 class="pref-label">Dock</h2>
    <div class="pref-control">
      <label class="check"><input class="dock" type="checkbox" checked aria-describedby="dock-hint" /> Show Mark in the Dock</label>
      <p class="pref-hint" id="dock-hint">Its icon opens the editor, and ⌘-Tab finds it. Off, Mark is in the menu bar alone.</p>
      <p class="pref-note dock-note" role="status" hidden></p>
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
      <label class="check"><input class="auto-install" type="checkbox" aria-describedby="auto-install-hint" /> Download and install updates automatically</label>
      <p class="pref-hint" id="auto-install-hint">Mark installs one while you're not using it, then reopens in the background.</p>
      <button class="check-now glassy" type="button">Check Now</button>
    </div>
  </section>
  <p class="pref-preview" hidden>Browser preview: settings apply in the Mac app.</p>
  <p class="pref-version" hidden></p>`;

const recorders = [...root.querySelectorAll<HTMLButtonElement>('.recorder')];
const shortcutNote = root.querySelector<HTMLElement>('.shortcut-note')!;
const login = root.querySelector<HTMLInputElement>('.login')!;
const loginNote = root.querySelector<HTMLElement>('.login-note')!;
const dock = root.querySelector<HTMLInputElement>('.dock')!;
const dockNote = root.querySelector<HTMLElement>('.dock-note')!;
const autoUpdate = root.querySelector<HTMLInputElement>('.auto-update')!;
const autoInstall = root.querySelector<HTMLInputElement>('.auto-install')!;
const thumbnailAfter = root.querySelector<HTMLInputElement>('.thumbnail-after')!;
const afterNote = root.querySelector<HTMLElement>('.after-note')!;
const mcp = root.querySelector<HTMLInputElement>('.mcp')!;
const mcpNote = root.querySelector<HTMLElement>('.mcp-note')!;
const recordMic = root.querySelector<HTMLInputElement>('.record-mic')!;
const recordPointer = root.querySelector<HTMLSelectElement>('.record-pointer')!;
const recordClicks = root.querySelector<HTMLSelectElement>('.record-clicks')!;
const recordZoom = root.querySelector<HTMLInputElement>('.record-zoom')!;
const recordNote = root.querySelector<HTMLElement>('.record-note')!;
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
  autoInstall.checked = settings.installUpdates === true;
  thumbnailAfter.checked = settings.afterCapture === 'thumbnail';
  mcp.checked = settings.mcp !== false;
  dock.checked = settings.showInDock !== false;
  recordMic.checked = settings.recordMic === true;
  const look = lookOf({ pointer: settings.recordingPointer, clicks: settings.recordingClicks });
  recordPointer.value = look.pointer;
  recordClicks.value = look.clicks;
  recordZoom.checked = settings.recordZoom === true;
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

dock.addEventListener('change', () => {
  note(dockNote, null);
  void command<Settings>('set_show_in_dock', { show: dock.checked }).then(show)
    .catch(error => { note(dockNote, String(error)); dock.checked = current.showInDock !== false; });
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

const recordOptions = [[recordMic, 'mic'], [recordPointer, 'pointer'], [recordClicks, 'clicks'], [recordZoom, 'zoom']] as const;
for (const [control, option] of recordOptions) {
  control.addEventListener('change', () => {
    note(recordNote, null);
    const value = control instanceof HTMLInputElement ? control.checked : control.value;
    void command<Settings>('set_record_options', { [option]: value }).then(show).catch(error => {
      note(recordNote, String(error));
      show(current);
    });
  });
}

// Adding Mark to an AI tool, in the tool's own way: a link that opens it to ask,
// a command for Terminal, or the lines for its settings file.
const agentPick = root.querySelector<HTMLSelectElement>('.agent')!;
const addAgent = root.querySelector<HTMLButtonElement>('.add-agent')!;
let agents: Agent[] = [];
const chosenAgent = () => agents.find(agent => agent.name === agentPick.value);

const agentHint = root.querySelector<HTMLElement>('.agent-hint')!;

/** The button says what it will do for the tool chosen, and a line under it
 *  which of the tool's agents that is for, where it could be mistaken. */
function labelAdd() {
  const agent = chosenAgent();
  agentHint.textContent = agent?.hint ?? '';
  agentHint.hidden = !agent?.hint;
  addAgent.disabled = !agent;
  addAgent.textContent = agent?.kind === 'link' ? `Add to ${agent.name}` : agent?.kind === 'config' ? 'Copy Config'
    : agent?.kind === 'form' ? 'Copy Path' : 'Copy Command';
}

async function loadAgents() {
  try {
    agents = await command<Agent[]>('mcp_setup');
    agentPick.replaceChildren(...[...new Set(agents.map(agent => agent.group))].map(group => {
      const list = document.createElement('optgroup');
      list.label = group;
      list.append(...agents.filter(agent => agent.group === group).map(agent => new Option(agent.name, agent.name)));
      return list;
    }));
    agentPick.disabled = false;
  } catch (error) { note(mcpNote, String(error)); }
  labelAdd();
}

agentPick.addEventListener('change', () => { note(mcpNote, null); labelAdd(); });
addAgent.addEventListener('click', async () => {
  const agent = chosenAgent();
  if (!agent) return;
  note(mcpNote, null);
  try {
    if (agent.kind === 'link') {
      await command('add_to_agent', { name: agent.name });
      note(mcpNote, `${agent.name} opens and asks whether to add Mark.`, true);
    } else if (agent.kind === 'command') {
      await command('copy_text', { text: agent.text });
      note(mcpNote, 'Copied. Paste it into Terminal and press Return.', true);
    } else if (agent.kind === 'form') {
      await command('copy_text', { text: agent.text });
      // --mcp kept whole: broken after its first hyphen, it reads as two words.
      note(mcpNote, `Copied Mark’s path. ${agent.steps?.replaceAll('--mcp', '-\u2060-\u2060mcp')}`, true);
    } else {
      await command('copy_text', { text: agent.text });
      note(mcpNote, `Copied. Add it to ${agent.place}${agent.restart ? `, then quit and reopen ${agent.name}` : ''}.`, true);
    }
  } catch (error) { note(mcpNote, String(error)); }
});

// The guide, at the tool picked: each one's setup step by step, and how to ask.
root.querySelector<HTMLButtonElement>('.guide')!.addEventListener('click', () => {
  void command('open_guide', { name: chosenAgent()?.name ?? null }).catch(error => note(mcpNote, String(error)));
});

autoUpdate.addEventListener('change', () => {
  void command<Settings>('set_auto_update', { enabled: autoUpdate.checked }).then(show)
    .catch(() => { autoUpdate.checked = current.checkUpdates !== false; });
});
// Installing by itself means looking by itself, and not looking means not
// installing: Rust keeps the two in step, and show() reflects both.
autoInstall.addEventListener('change', () => {
  void command<Settings>('set_install_updates', { enabled: autoInstall.checked }).then(show)
    .catch(() => { autoInstall.checked = current.installUpdates === true; });
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
  const [settings, enabled, records] = await Promise.all([command<Settings>('get_settings'), command<boolean>('login_enabled'),
    command<boolean>('recording_supported').catch(() => false)]);
  for (const element of root.querySelectorAll<HTMLElement>('[data-records]')) element.hidden = !records;
  show(settings);
  void loadAgents();
  login.checked = enabled;
  // The first thing anyone testing a build is asked is which build.
  const { getVersion } = await import('@tauri-apps/api/app');
  const version = root.querySelector<HTMLElement>('.pref-version')!;
  version.textContent = `Mark ${await getVersion()}`;
  version.hidden = false;
}
void init();
