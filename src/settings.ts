import './style.css';
import { command, isTauri } from './platform';
import { fitWindowTo } from './fit';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutFromEvent, shortcutProblem } from './shortcut';
import { CLICKS, POINTERS, lookOf, type ClickLook, type PointerLook } from './look';
import pkg from '../package.json';

/** Mark's settings window: each thing applied the moment it changes, with
 *  nothing to save, in tabs -- General, Capture, Recording, AI tools -- of
 *  rows, each with what it is on the left and its control on the right.
 *  Appearance, the shortcuts, what follows a capture, AI tools and updates are
 *  Mark's own; login and Screen Recording are read from macOS, which is the
 *  only source of truth for them. */

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

/** What each way in does, under its name. */
const WAY_DETAILS: Record<Way, string> = {
  region: 'Drag over what you want.', window: 'Click the window you want.', display: 'Everything on one screen.',
  timed: 'Counts down first, to catch a menu or a hover.', record: 'Choose what to record, then press Record.',
};

/** The ▾ beside a list's choice. */
const CHEVRON = '<svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.6 8.4 10 11.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const APPEARANCES: { id: Settings['appearance']; name: string }[] = [
  { id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }, { id: 'system', name: 'Match System' },
];

/** The tabs, each a page of rows. Recording shows only on a Mac that can record. */
type Tab = 'general' | 'capture' | 'recording' | 'ai';
const TABS: { tab: Tab; name: string }[] = [
  { tab: 'general', name: 'General' }, { tab: 'capture', name: 'Capture' },
  { tab: 'recording', name: 'Recording' }, { tab: 'ai', name: 'AI tools' },
];

/** A row: its name and what it does on the left, the control on the right.
 *  One with a checkbox is a label, so the whole row turns it on and off. */
const row = (title: string, id: string, control: string, detail = '', note = '') => `
  <div class="row">
    <div class="row-text"><span class="row-title" id="${id}">${title}</span>
      ${detail ? `<p class="row-detail" id="${id}-detail">${detail}</p>` : ''}${note}</div>
    ${control}
  </div>`;
const checkRow = (title: string, id: string, input: string, detail = '', note = '') => `
  <label class="row">
    <span class="row-text"><span class="row-title" id="${id}">${title}</span>
      ${detail ? `<span class="row-detail" id="${id}-detail">${detail}</span>` : ''}${note}</span>
    <input ${input} type="checkbox" aria-labelledby="${id}"${detail ? ` aria-describedby="${id}-detail"` : ''} />
  </label>`;
const menu = (select: string) => `<span class="menu">${select}${CHEVRON}</span>`;

const root = document.querySelector<HTMLDivElement>('#settings')!;
root.className = 'prefs';
root.innerHTML = `
  <nav class="tabs" role="tablist" aria-label="Settings">
    ${TABS.map(({ tab, name }) => `<button class="tab" type="button" role="tab" id="tab-${tab}" aria-controls="pane-${tab}" aria-selected="false" data-tab="${tab}"${tab === 'recording' ? ' data-records hidden' : ''}>${name}</button>`).join('')}
  </nav>
  <div class="panes">
    <section class="pane" role="tabpanel" id="pane-general" aria-labelledby="tab-general" data-pane="general">
      ${row('Appearance', 'appearance-title', `<div class="segments" role="radiogroup" aria-labelledby="appearance-title">
        ${APPEARANCES.map(a => `<button class="segment" type="button" role="radio" aria-checked="${a.id === 'dark'}" data-appearance="${a.id}">${a.name}</button>`).join('')}
      </div>`)}
      ${row('Screen Recording', 'screen-title', `<span class="status screen-allowed"><i></i>Allowed</span>
        <button class="quiet screen-open" type="button" aria-describedby="screen-title" hidden>Open System Settings…</button>`,
        'Mark needs it to capture anything.')}
      ${checkRow('Show Mark in the Dock', 'dock-title', 'class="dock" checked',
        'Its icon opens the editor, and ⌘-Tab finds it. Off, Mark is in the menu bar alone.',
        '<span class="pref-note dock-note" role="status" hidden></span>')}
      ${checkRow('Open Mark at login', 'login-title', 'class="login"', '', '<span class="pref-note login-note" role="status" hidden></span>')}
      ${row('Mark', 'version-title', '<button class="quiet check-now" type="button" aria-describedby="version-title">Check for updates</button>', '',
        '<p class="row-detail update-state" role="status" hidden></p>')}
      ${checkRow('Check for updates automatically', 'auto-update-title', 'class="auto-update" checked', 'Once a day, and shortly after Mark opens.')}
      ${checkRow('Install updates automatically', 'auto-install-title', 'class="auto-install"',
        'Mark installs one while you’re not using it, then reopens in the background.')}
    </section>
    <section class="pane" role="tabpanel" id="pane-capture" aria-labelledby="tab-capture" data-pane="capture">
      <p class="pane-intro" id="recorder-hint">Click a shortcut, then press the keys you want.</p>
      ${WAYS.map(({ way, name }) => `<div class="row"${way === 'record' ? ' data-records hidden' : ''}>
        <div class="row-text"><span class="row-title way-name" id="way-${way}">${name}</span><p class="row-detail">${WAY_DETAILS[way]}</p></div>
        <span class="recorder-keys" aria-hidden="true">esc cancels · ⌫ ${way === 'region' ? `resets to ${prettyShortcut(DEFAULT_SHORTCUT)}` : 'clears'}</span>
        <button class="recorder" type="button" data-way="${way}" aria-labelledby="way-${way}" aria-describedby="recorder-hint"><kbd>${way === 'region' ? prettyShortcut(DEFAULT_SHORTCUT) : 'None'}</kbd></button>
      </div>`).join('')}
      <p class="pref-note shortcut-note" role="status" hidden></p>
      ${checkRow('Show a thumbnail instead of the editor', 'thumbnail-title', 'class="thumbnail-after"',
        'Copied at once, it waits in the corner: click it to mark it up, or drag it into any app.',
        '<span class="pref-note after-note" role="status" hidden></span>')}
    </section>
    <section class="pane" role="tabpanel" id="pane-recording" aria-labelledby="tab-recording" data-pane="recording" data-records hidden>
      ${checkRow('Record the microphone too', 'record-mic-title', 'class="record-mic"',
        'macOS asks the first time. The microphone button beside Record turns it on and off too.')}
      ${row('Pointer', 'record-pointer-title', menu(`<select class="record-pointer" aria-labelledby="record-pointer-title" aria-describedby="record-pointer-title-detail">
        ${POINTERS.map(choice => `<option value="${choice.id}">${choice.name}</option>`).join('')}</select>`),
        'Touch shows a fingertip, for a phone prototype; Halo a soft glow round the arrow.')}
      ${row('Clicks', 'record-clicks-title', menu(`<select class="record-clicks" aria-labelledby="record-clicks-title" aria-describedby="record-clicks-title-detail">
        ${CLICKS.map(choice => `<option value="${choice.id}">${choice.name}</option>`).join('')}</select>`),
        'Rings are macOS’s own; Ripple grows and fades where you tap.')}
      ${checkRow('Zoom in on clicks', 'record-zoom-title', 'class="record-zoom"',
        'A recording opens with the picture moving in gently round each burst of clicks.')}
      <p class="pane-outro">The bar beside Record changes these too, and the editor changes Halo, Touch, Ripple and each zoom afterwards.</p>
      <p class="pref-note record-note" role="status" hidden></p>
    </section>
    <section class="pane" role="tabpanel" id="pane-ai" aria-labelledby="tab-ai" data-pane="ai">
      ${checkRow('Let AI tools ask for screenshots', 'mcp-title', 'class="mcp" checked',
        'Claude, ChatGPT, Cursor, Copilot and other AI tools can ask; nothing is sent until you press Send.')}
      <div class="row stacked">
        <div class="row-text"><span class="row-title" id="agent-label">Add Mark to</span>
          <p class="row-detail agent-hint">Pick the AI tool you use.</p></div>
        <div class="add-to">
          ${menu('<select class="agent" aria-labelledby="agent-label" disabled></select>')}
          <button class="quiet add-agent" type="button" disabled>Copy Command</button>
        </div>
        <div class="add-after">
          <p class="pref-note mcp-note" role="status" hidden></p>
          <button class="guide" type="button">How to set it up and use it</button>
        </div>
      </div>
    </section>
  </div>
  <p class="pref-preview" hidden>Browser preview: settings apply in the Mac app.</p>`;

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

/** The tab shown, kept for the next time Settings opens. Every page stays laid
 *  out, the others hidden, so the window is as tall as the tallest and keeps
 *  its size from tab to tab. */
const TAB_KEY = 'mark.settings.tab';
const tabs = [...root.querySelectorAll<HTMLButtonElement>('.tab')];
const savedTab = (): string | null => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } };
function choose(tab: string | null, focus = false, remember = true) {
  const chosen = tabs.find(button => button.dataset.tab === tab && !button.hidden) ?? tabs[0];
  for (const button of tabs) {
    const on = button === chosen;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    root.querySelector(`#pane-${button.dataset.tab}`)!.classList.toggle('active', on);
  }
  if (recording) stopRecording();
  if (focus) chosen.focus();
  if (remember) try { localStorage.setItem(TAB_KEY, chosen.dataset.tab!); } catch { /* remembered for this visit only */ }
}
const tabList = root.querySelector<HTMLElement>('.tabs')!;
tabList.addEventListener('click', event => {
  const tab = (event.target as Element).closest<HTMLButtonElement>('.tab');
  if (tab) choose(tab.dataset.tab!);
});
// Left and right move along the tabs, as in any tab list.
tabList.addEventListener('keydown', event => {
  const shown = tabs.filter(button => !button.hidden);
  const at = shown.indexOf(event.target as HTMLButtonElement);
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (at < 0 || !step) return;
  event.preventDefault();
  choose(shown[(at + step + shown.length) % shown.length].dataset.tab!, true);
});
choose(savedTab(), false, false);

/** Screen Recording, as macOS has it: allowed, or a way to System Settings to
 *  allow it. Looked at again whenever the window comes forward, which is when
 *  someone has just been there. */
const screenAllowed = root.querySelector<HTMLElement>('.screen-allowed')!;
const screenOpen = root.querySelector<HTMLButtonElement>('.screen-open')!;
const screenDetail = root.querySelector<HTMLElement>('#screen-title-detail')!;
function showScreenAccess(allowed: boolean) {
  screenAllowed.hidden = !allowed;
  screenOpen.hidden = allowed;
  screenDetail.hidden = allowed;
}
const lookAtScreenAccess = () => command<boolean>('screen_access_granted').then(allowed => showScreenAccess(allowed !== false)).catch(() => {});
screenOpen.addEventListener('click', () => { void command('open_screen_settings').catch(() => {}); });
window.addEventListener('focus', () => { if (isTauri) void lookAtScreenAccess(); });

/** Which Mark this is, and whether there's a newer one: looked for here, and
 *  shown in Software Update once there is. */
interface Offer { version: string }
const versionTitle = root.querySelector<HTMLElement>('#version-title')!;
const updateState = root.querySelector<HTMLElement>('.update-state')!;
const checkNow = root.querySelector<HTMLButtonElement>('.check-now')!;
let offered: Offer | null = null;
function showOffer(offer: Offer | null, text: string | null, failed = false) {
  offered = offer;
  note(updateState, text);
  updateState.classList.toggle('failed', failed);
  checkNow.textContent = offer ? 'Update…' : 'Check for updates';
  checkNow.classList.toggle('strong', Boolean(offer));
}
checkNow.addEventListener('click', async () => {
  if (offered) { void command('open_updates').catch(() => {}); return; }
  checkNow.disabled = true;
  showOffer(null, 'Checking…');
  try {
    const offer = await command<Offer | null>('check_for_update');
    showOffer(offer, offer ? `Mark ${offer.version} is available.` : 'Up to date');
  } catch (error) {
    showOffer(null, String(error).replace(/^Error: /, ''), true);
  } finally {
    checkNow.disabled = false;
  }
});

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

/** What the button does for each kind of tool, said above it where the tool
 *  has nothing more particular to say. */
const DOES: Record<Agent['kind'], string> = {
  command: 'Copies a command to paste into Terminal.', link: 'Opens the tool, which asks whether to add Mark.',
  config: 'Copies the lines for the tool’s settings file.', form: 'Copies Mark’s path, for the tool’s own settings.',
};

/** The button says what it will do for the tool chosen, and the line above it
 *  which of the tool's agents that is for, where it could be mistaken. */
function labelAdd() {
  const agent = chosenAgent();
  agentHint.textContent = agent ? agent.hint ?? DOES[agent.kind] : 'Pick the AI tool you use.';
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
    for (const element of root.querySelectorAll<HTMLElement>('[data-records]')) element.hidden = false;
    versionTitle.textContent = `Mark ${pkg.version}`;
    showScreenAccess(true);
    show(current);
    choose(savedTab(), false, false);
    return;
  }
  const [settings, enabled, records] = await Promise.all([command<Settings>('get_settings'), command<boolean>('login_enabled'),
    command<boolean>('recording_supported').catch(() => false)]);
  for (const element of root.querySelectorAll<HTMLElement>('[data-records]')) element.hidden = !records;
  show(settings);
  choose(savedTab(), false, false);
  void loadAgents();
  void lookAtScreenAccess();
  login.checked = enabled;
  // An update a check already found, ready to show.
  void command<Offer | null>('pending_update').then(offer => { if (offer) showOffer(offer, `Mark ${offer.version} is available.`); }).catch(() => {});
  // The first thing anyone testing a build is asked is which build.
  const { getVersion } = await import('@tauri-apps/api/app');
  versionTitle.textContent = `Mark ${await getVersion()}`;
}
void init();
