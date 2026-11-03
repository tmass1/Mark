/** Frame: the capture set on a background, with room around it, rounded
 *  corners, a shadow and, if wanted, a device round it -- a window's title
 *  bar, a browser's, a phone or a tablet -- the way a screenshot or a
 *  recording is dressed to be shown to someone rather than pasted into a bug.
 *
 *  Everything here is shared by the two places a frame appears: the canvas,
 *  which previews it, and the export, which draws it into the image. One set of
 *  numbers, so what is copied is what was shown. Padding, corners and shadow
 *  are shares of the image's own size, so a small capture and a large one look
 *  alike; the title bar is a real one's height, in the capture's points. */

export interface FrameStyle {
  on: boolean;
  /** One of BACKGROUNDS, by id. */
  background: string;
  /** 0 to 1 each, as the sliders give them; frameGeometry says what they mean. */
  padding: number;
  radius: number;
  shadow: number;
  /** What goes round it: nothing, a window's title bar, a browser's, or a
   *  phone or tablet, whose screen's corners are its own. */
  device: Device;
  /** A phone's or tablet's colour. */
  color: BodyColour;
  /** A phone's Dynamic Island, drawn over the top of its screen. */
  island: boolean;
}

export type Device = 'none' | 'window' | 'browser' | 'phone' | 'tablet';
export type BodyColour = 'black' | 'silver' | 'titanium' | 'blue';

export const DEFAULT_FRAME: FrameStyle = {
  on: false, background: 'sky', padding: 0.5, radius: 0.4, shadow: 0.5, device: 'none', color: 'black', island: false,
};

/** The devices, each with a small picture of itself for the panel. */
export const DEVICES: { id: Device; name: string; art: string }[] = [
  { id: 'none', name: 'None', art: '<rect x="5" y="7" width="22" height="16" rx="2.5" fill="currentColor" opacity=".18"/>' },
  { id: 'window', name: 'Window',
    art: '<rect x="4" y="6" width="24" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 11h24" stroke="currentColor" stroke-width="1.4"/><circle cx="7.5" cy="8.6" r="1" fill="currentColor"/><circle cx="10.5" cy="8.6" r="1" fill="currentColor"/><circle cx="13.5" cy="8.6" r="1" fill="currentColor"/>' },
  { id: 'browser', name: 'Browser',
    art: '<rect x="4" y="6" width="24" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 12.5h24" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="8" width="12" height="3" rx="1.5" fill="currentColor" opacity=".55"/><circle cx="7.3" cy="9.4" r=".9" fill="currentColor"/>' },
  { id: 'phone', name: 'Phone',
    art: '<rect x="10.5" y="3.5" width="11" height="25" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="5.6" width="4" height="1.4" rx=".7" fill="currentColor"/>' },
  { id: 'tablet', name: 'Tablet',
    art: '<rect x="6.5" y="4.5" width="19" height="23" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="6.6" r=".8" fill="currentColor"/>' },
];

/** A phone's or tablet's metal: its band, the lighter edge that catches the
 *  light, and a name. The bezel round the screen is black whatever it is. */
export const BODY_COLOURS: { id: BodyColour; name: string; band: string; edge: string }[] = [
  { id: 'black', name: 'Black', band: '#3a3a3d', edge: '#77777d' },
  { id: 'silver', name: 'Silver', band: '#d9dadc', edge: '#ffffff' },
  { id: 'titanium', name: 'Natural Titanium', band: '#bdb6aa', edge: '#ebe6dd' },
  { id: 'blue', name: 'Deep Blue', band: '#3f4b5e', edge: '#7d8ba1' },
];

/** Whether it is held: a phone or a tablet, with a body and its own corners. */
export const handheld = (device: Device) => device === 'phone' || device === 'tablet';

export interface Background {
  id: string;
  name: string;
  /** Colours, start to end; one is a solid, none is no background at all. */
  stops: string[];
  /** As CSS's linear-gradient: 0deg runs upward, 90deg to the right. */
  angle: number;
}

/** Six gradients and six solids, drawn in code so they cost nothing to ship
 *  and come out the same on screen and in the image. */
export const BACKGROUNDS: Background[] = [
  { id: 'sky', name: 'Sky', stops: ['#a1c4fd', '#c2e9fb'], angle: 135 },
  { id: 'dusk', name: 'Dusk', stops: ['#fbc2eb', '#a6c1ee'], angle: 135 },
  { id: 'peach', name: 'Peach', stops: ['#ffecd2', '#fcb69f'], angle: 135 },
  { id: 'lagoon', name: 'Lagoon', stops: ['#43cea2', '#185a9d'], angle: 135 },
  { id: 'aurora', name: 'Aurora', stops: ['#7f7fd5', '#86a8e7', '#91eae4'], angle: 135 },
  { id: 'midnight', name: 'Midnight', stops: ['#0f2027', '#203a43', '#2c5364'], angle: 160 },
  { id: 'clear', name: 'No background', stops: [], angle: 0 },
  { id: 'white', name: 'White', stops: ['#ffffff'], angle: 0 },
  { id: 'mist', name: 'Mist', stops: ['#e8eaed'], angle: 0 },
  { id: 'sand', name: 'Sand', stops: ['#efe6d8'], angle: 0 },
  { id: 'graphite', name: 'Graphite', stops: ['#2c2c2e'], angle: 0 },
  { id: 'black', name: 'Black', stops: ['#000000'], angle: 0 },
];

export function backgroundOf(id: string): Background {
  return BACKGROUNDS.find(background => background.id === id) ?? BACKGROUNDS[0];
}

/** Whatever was stored -- an older file, a hand-edited one -- as a frame that
 *  can be drawn: numbers kept to 0 to 1, a background that exists. */
export function sanitizeFrame(value: unknown): FrameStyle {
  const given = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof FrameStyle, unknown>>;
  const share = (x: unknown, fallback: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback;
  const flag = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback);
  return {
    on: flag(given.on, DEFAULT_FRAME.on),
    background: typeof given.background === 'string' && BACKGROUNDS.some(b => b.id === given.background)
      ? given.background : DEFAULT_FRAME.background,
    padding: share(given.padding, DEFAULT_FRAME.padding),
    radius: share(given.radius, DEFAULT_FRAME.radius),
    shadow: share(given.shadow, DEFAULT_FRAME.shadow),
    // A frame from before devices had a title bar or none (and, unreleased, a phone).
    device: DEVICES.some(device => device.id === given.device) ? given.device as Device
      : (given as { phone?: unknown }).phone === true ? 'phone' : (given as { chrome?: unknown }).chrome === true ? 'window' : DEFAULT_FRAME.device,
    color: BODY_COLOURS.some(colour => colour.id === given.color) ? given.color as BodyColour : DEFAULT_FRAME.color,
    island: flag(given.island, DEFAULT_FRAME.island),
  };
}

/** A title bar is 28 points, as a Mac's own; its lights sit on centres 20
 *  points apart, each 12 across. */
const BAR = 28;
export const LIGHTS = [
  { x: 20, fill: '#ff5f57', edge: '#e0443e' },
  { x: 40, fill: '#febc2e', edge: '#dea123' },
  { x: 60, fill: '#28c840', edge: '#1aab29' },
];
const LIGHT_RADIUS = 6;
export const BAR_COLOURS = {
  light: { fill: '#e9e9eb', line: '#00000017' },
  dark: { fill: '#2d2d2f', line: '#00000066' },
};

/** A browser's bar is taller than a window's, for its address field. */
const BROWSER_BAR = 52;
/** A phone's and a tablet's bezel, and their screens' corners, as shares of
 *  the screen's shorter side, about a current one's. */
const BEZEL = { phone: 0.044, tablet: 0.055 };
const SCREEN_CORNER = { phone: 0.135, tablet: 0.03 };
/** The metal band round the bezel, as a share of it, and how far a button
 *  stands out from the side. */
const BAND = 0.42;
const KNOB = 0.2;
/** A phone's Dynamic Island, in shares of the screen's shorter side. */
const ISLAND = { width: 0.32, height: 0.094, top: 0.028 };

/** Where everything goes, in image pixels. */
export interface FrameGeometry {
  /** The whole framed image. */
  width: number; height: number;
  /** Background showing around the window, the same on every side. */
  pad: number;
  /** The title bar's height; 0 without one. */
  bar: number;
  /** A phone's or tablet's bezel, band included, round the image on every
   *  side; 0 without one. */
  bezel: number;
  /** The window's corner radius -- for a phone or tablet, its screen's. */
  radius: number;
  shadow: { blur: number; y: number; alpha: number };
}

/** The sliders' 0 to 1 turned into pixels. The unit is the square root of the
 *  image's area: between its sides, so a long thin capture is neither
 *  smothered nor given a hairline. Whole pixels throughout, so the image lands
 *  on the grid and stays sharp. */
export function frameGeometry(width: number, height: number, density: number, style: FrameStyle): FrameGeometry {
  const unit = Math.sqrt(width * height);
  // A phone or tablet has no title bar, and its own corners rather than the
  // slider's -- and room enough for its buttons, however little padding.
  const short = Math.min(width, height);
  const held = style.device === 'phone' || style.device === 'tablet' ? style.device : null;
  const bezel = held ? Math.max(2, Math.round(BEZEL[held] * short)) : 0;
  const pad = Math.max(Math.round(style.padding * 0.16 * unit), held ? Math.ceil(bezel * KNOB) + 1 : 0);
  const bar = style.device === 'window' ? Math.round(BAR * Math.max(1, density))
    : style.device === 'browser' ? Math.round(BROWSER_BAR * Math.max(1, density)) : 0;
  const radius = held ? Math.round(SCREEN_CORNER[held] * short)
    : Math.min(Math.round(style.radius * 0.035 * unit), Math.floor(Math.min(width, height + bar) / 2));
  const shadow = style.shadow > 0
    ? { blur: Math.round(style.shadow * 0.07 * unit), y: Math.round(style.shadow * 0.025 * unit), alpha: 0.22 + 0.28 * style.shadow }
    : { blur: 0, y: 0, alpha: 0 };
  return { width: width + 2 * (pad + bezel), height: height + bar + 2 * (pad + bezel), pad, bar, bezel, radius, shadow };
}

/** The line a CSS linear-gradient runs along in a box: through the centre at
 *  its angle, and long enough that the far corners take the end colours. */
export function gradientLine(angle: number, width: number, height: number) {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2, cy = height / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/** A checkerboard for no background, as image editors show transparency. */
const CHECKERS = 'repeating-conic-gradient(#ffffff 0 25%, #e3e3e6 0 50%) 0 0 / 14px 14px';

export function cssBackground(background: Background): string {
  if (!background.stops.length) return CHECKERS;
  if (background.stops.length === 1) return background.stops[0];
  return `linear-gradient(${background.angle}deg, ${background.stops.join(', ')})`;
}

/** The lights as a picture, for the title bar on screen: the export draws the
 *  same circles itself. Scaled to the bar's height, as they are in the export. */
export const LIGHTS_SVG = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 76 ${BAR}" width="76" height="${BAR}">`
  + LIGHTS.map(light => `<circle cx="${light.x}" cy="${BAR / 2}" r="${LIGHT_RADIUS - 0.25}" fill="${light.fill}" stroke="${light.edge}" stroke-width=".5"/>`).join('')
  + '</svg>')}")`;

/** Whether a title bar over this image should be dark: when the image's top
 *  edge is. Transparent pixels -- a window's own rounded corners -- don't count. */
export function darkTop(image: CanvasImageSource, width: number, height: number): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || !width || !height) return false;
  context.drawImage(image, 0, 0, width, Math.max(1, Math.round(height * 0.02)), 0, 0, 32, 1);
  const data = context.getImageData(0, 0, 32, 1).data;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    count++;
  }
  return count > 0 && sum / count < 0.5;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export function paintBackground(context: CanvasRenderingContext2D, background: Background, width: number, height: number) {
  if (!background.stops.length) return;              // no background: left transparent
  if (background.stops.length === 1) context.fillStyle = background.stops[0];
  else {
    const line = gradientLine(background.angle, width, height);
    const gradient = context.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
    background.stops.forEach((colour, i) => gradient.addColorStop(i / (background.stops.length - 1), colour));
    context.fillStyle = gradient;
  }
  context.fillRect(0, 0, width, height);
}

/** Where the window -- or the phone's screen -- is, title bar and all, in the
 *  framed image's pixels, and the outside of whatever casts the shadow. */
function windowOf(geometry: FrameGeometry, image: { width: number; height: number }) {
  const { pad, bar, bezel, radius } = geometry;
  return {
    x: pad + bezel, y: pad + bezel, width: image.width, height: image.height + bar, radius,
    body: { x: pad, y: pad, width: image.width + 2 * bezel, height: image.height + bar + 2 * bezel, radius: radius + bezel },
  };
}

/** The framed image: background, the shadow, a phone's or tablet's body if
 *  it has one, then the window itself -- title bar and image -- clipped to its
 *  rounded corners, and a phone's island over it. `draw` puts the image and
 *  its marks down with the origin at the image's top left. The context may be
 *  scaled, as the editor's preview is; the shadow is scaled with it. */
export function paintFrame(context: CanvasRenderingContext2D, geometry: FrameGeometry, style: FrameStyle,
                           image: { width: number; height: number; dark: boolean }, draw: () => void) {
  const { bar, bezel, shadow } = geometry;
  paintBackground(context, backgroundOf(style.background), geometry.width, geometry.height);
  const { x, y, width, height, radius, body } = windowOf(geometry, image);
  if (shadow.alpha > 0 && (shadow.blur > 0 || shadow.y > 0)) {
    // Cast by a shape drawn wholly off the canvas, its shadow offset back on:
    // so the shadow lands and the shape never does, and a window's transparent
    // corners show the background rather than a fill behind them. A shadow is
    // in the canvas's own pixels, whatever the scale, so it is scaled here.
    const transform = context.getTransform();
    const scale = Math.hypot(transform.a, transform.b) || 1;
    const away = geometry.width + geometry.height + shadow.blur * 4;
    context.save();
    context.shadowColor = `rgba(0, 0, 0, ${shadow.alpha.toFixed(3)})`;
    context.shadowBlur = shadow.blur * scale;
    context.shadowOffsetX = away * scale;
    context.shadowOffsetY = shadow.y * scale;
    context.fillStyle = '#000';
    roundedRect(context, body.x - away, body.y, body.width, body.height, body.radius);
    context.fill();
    context.restore();
  }
  if (bezel) paintBody(context, body, bezel, style);
  context.save();
  roundedRect(context, x, y, width, height, radius);
  context.clip();
  if (bar) paintBar(context, { x, y, width, bar }, style.device === 'browser', image.dark);
  context.translate(x, y + bar);
  draw();
  context.restore();
  if (style.device === 'phone' && style.island) paintIsland(context, { x, y, width, height });
}

/** A window's title bar, its three lights, and -- a browser's -- the arrows
 *  and the address field in the middle of a taller bar. */
function paintBar(context: CanvasRenderingContext2D, { x, y, width, bar }: { x: number; y: number; width: number; bar: number },
                  browser: boolean, dark: boolean) {
  const colours = dark ? BAR_COLOURS.dark : BAR_COLOURS.light;
  const scale = bar / (browser ? BROWSER_BAR : BAR);
  context.fillStyle = colours.fill;
  context.fillRect(x, y, width, bar);
  context.fillStyle = colours.line;
  context.fillRect(x, y + bar - Math.max(1, Math.round(scale)), width, Math.max(1, Math.round(scale)));
  // The lights are a real one's size whatever the bar's height.
  const centre = y + bar / 2;
  for (const light of LIGHTS) {
    context.beginPath();
    context.arc(x + light.x * scale, centre, (LIGHT_RADIUS - 0.25) * scale, 0, Math.PI * 2);
    context.fillStyle = light.fill;
    context.fill();
    context.lineWidth = 0.5 * scale;
    context.strokeStyle = light.edge;
    context.stroke();
  }
  if (!browser) return;
  // Back and forward, then the address field, centred in what is left.
  context.strokeStyle = dark ? '#ffffff59' : '#0000004d';
  context.lineWidth = 1.6 * scale;
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (const [at, way] of [[90, -1], [112, 1]] as const) {
    context.beginPath();
    context.moveTo(x + (at - way * 3) * scale, centre - 5.5 * scale);
    context.lineTo(x + (at + way * 3) * scale, centre);
    context.lineTo(x + (at - way * 3) * scale, centre + 5.5 * scale);
    context.stroke();
  }
  const field = { width: Math.min(width * 0.56, 620 * scale), height: 30 * scale };
  const left = x + Math.max(136 * scale, (width - field.width) / 2);
  roundedRect(context, left, centre - field.height / 2, Math.min(field.width, x + width - left - 16 * scale), field.height, 8 * scale);
  context.fillStyle = dark ? '#ffffff1f' : '#0000000f';
  context.fill();
  // A lock at the start of it.
  const lock = { x: left + 14 * scale, y: centre };
  context.fillStyle = dark ? '#ffffff73' : '#00000059';
  roundedRect(context, lock.x - 4 * scale, lock.y - 1 * scale, 8 * scale, 6.5 * scale, 1.5 * scale);
  context.fill();
  context.beginPath();
  context.arc(lock.x, lock.y - 1 * scale, 2.6 * scale, Math.PI, 0);
  context.strokeStyle = context.fillStyle; context.lineWidth = 1.3 * scale;
  context.stroke();
}

/** A colour mixed towards white (`amount` above 0) or black (below), as a
 *  shade of metal is lit or in shadow. */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const towards = amount > 0 ? 255 : 0, share = Math.min(1, Math.abs(amount));
  const channel = (shift: number) => Math.round(((value >> shift) & 255) + (towards - ((value >> shift) & 255)) * share);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** A phone's or tablet's body, as a current one is made: its buttons standing
 *  out of the sides, rounded and lit like the metal; the metal band itself,
 *  lit from the top left, with a dark outer edge, a bright line just inside
 *  it, and the short antenna lines across it; a dark line where it meets the
 *  glass; and the black bezel under the glass, its edge catching the light. */
function paintBody(context: CanvasRenderingContext2D, body: { x: number; y: number; width: number; height: number; radius: number },
                   bezel: number, style: FrameStyle) {
  const colour = BODY_COLOURS.find(each => each.id === style.color) ?? BODY_COLOURS[0];
  const band = Math.max(1, Math.round(bezel * BAND));
  const knob = Math.max(1, Math.ceil(bezel * KNOB));
  const hair = Math.max(1, band * 0.12);
  const metal = (x0: number, y0: number, x1: number, y1: number) => {
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, shade(colour.band, 0.2));
    gradient.addColorStop(0.5, colour.band);
    gradient.addColorStop(1, shade(colour.band, -0.25));
    return gradient;
  };
  // Buttons first, so the body sits over their inner ends: a phone's action
  // button and volume on the left, power on the right; a tablet's top button.
  // Each is round in section, so lit across it.
  const button = (x: number, y: number, width: number, height: number, across: 'x' | 'y') => {
    const gradient = across === 'x' ? context.createLinearGradient(x, 0, x + width, 0) : context.createLinearGradient(0, y, 0, y + height);
    gradient.addColorStop(0, shade(colour.band, -0.3));
    gradient.addColorStop(0.45, shade(colour.band, 0.25));
    gradient.addColorStop(1, shade(colour.band, -0.2));
    roundedRect(context, x, y, width, height, Math.min(width, height) / 2);
    context.fillStyle = gradient;
    context.fill();
    context.lineWidth = hair;
    context.strokeStyle = shade(colour.band, -0.45);
    context.stroke();
  };
  if (style.device === 'phone') {
    for (const [side, at, length] of [[-1, 0.17, 0.035], [-1, 0.23, 0.065], [-1, 0.31, 0.065], [1, 0.25, 0.1]] as const) {
      const x = side < 0 ? body.x - knob : body.x + body.width - band;
      button(x, body.y + body.height * at, knob + band, body.height * length, 'x');
    }
  } else if (style.device === 'tablet') {
    button(body.x + body.width * 0.74, body.y - knob, body.width * 0.07, knob + band, 'y');
  }
  // The band, lit from the top left.
  roundedRect(context, body.x, body.y, body.width, body.height, body.radius);
  context.fillStyle = metal(body.x, body.y, body.x + body.width, body.y + body.height);
  context.fill();
  // Its outer edge, dark, so it stands off any background.
  context.lineWidth = hair;
  context.strokeStyle = shade(colour.band, -0.5);
  roundedRect(context, body.x + hair / 2, body.y + hair / 2, body.width - hair, body.height - hair, body.radius - hair / 2);
  context.stroke();
  // A bright line just inside it, strongest where the light falls.
  const inset = band * 0.28;
  const light = context.createLinearGradient(body.x, body.y, body.x + body.width, body.y + body.height);
  light.addColorStop(0, colour.edge);
  light.addColorStop(0.55, `${colour.edge}55`);
  light.addColorStop(1, `${colour.edge}22`);
  context.lineWidth = Math.max(1, band * 0.16);
  context.strokeStyle = light;
  roundedRect(context, body.x + inset, body.y + inset, body.width - 2 * inset, body.height - 2 * inset, body.radius - inset);
  context.stroke();
  // The antenna lines: short breaks across the band near each corner.
  if (style.device === 'phone') {
    context.strokeStyle = shade(colour.band, -0.35);
    context.lineWidth = Math.max(1, band * 0.22);
    const near = body.radius * 1.15;
    for (const y of [body.y + near, body.y + body.height - near]) {
      for (const x of [body.x, body.x + body.width - band]) {
        context.beginPath(); context.moveTo(x, y); context.lineTo(x + band, y); context.stroke();
      }
    }
    for (const x of [body.x + body.width * 0.24, body.x + body.width * 0.76]) {
      context.beginPath(); context.moveTo(x, body.y + body.height - band); context.lineTo(x, body.y + body.height); context.stroke();
    }
  }
  // Where the band meets the glass: a dark line, then the bezel under it.
  const glass = { x: body.x + band, y: body.y + band, width: body.width - 2 * band, height: body.height - 2 * band, radius: body.radius - band };
  roundedRect(context, glass.x, glass.y, glass.width, glass.height, glass.radius);
  context.fillStyle = '#040405';
  context.fill();
  context.lineWidth = Math.max(1, band * 0.18);
  context.strokeStyle = shade(colour.band, -0.65);
  context.stroke();
  // The glass's own edge, catching the light along the top.
  const edge = context.createLinearGradient(0, glass.y, 0, glass.y + glass.height);
  edge.addColorStop(0, '#ffffff2e'); edge.addColorStop(0.3, '#ffffff0d'); edge.addColorStop(1, '#ffffff08');
  context.lineWidth = Math.max(1, (bezel - band) * 0.08);
  context.strokeStyle = edge;
  const lip = context.lineWidth * 1.5;
  roundedRect(context, glass.x + lip, glass.y + lip, glass.width - 2 * lip, glass.height - 2 * lip, glass.radius - lip);
  context.stroke();
  if (style.device === 'tablet') {
    // Its front camera, in the middle of the top bezel.
    const camera = { x: body.x + body.width / 2, y: body.y + band + (bezel - band) / 2, r: Math.max(1, (bezel - band) * 0.14) };
    context.beginPath();
    context.arc(camera.x, camera.y, camera.r, 0, Math.PI * 2);
    context.fillStyle = '#16181f';
    context.fill();
    context.beginPath();
    context.arc(camera.x - camera.r * 0.3, camera.y - camera.r * 0.3, camera.r * 0.28, 0, Math.PI * 2);
    context.fillStyle = '#3a4152';
    context.fill();
  }
}

/** A phone's Dynamic Island: a black pill over the top of the screen, its
 *  camera's lens towards the right end of it. */
function paintIsland(context: CanvasRenderingContext2D, screen: { x: number; y: number; width: number; height: number }) {
  const short = Math.min(screen.width, screen.height);
  const width = ISLAND.width * short, height = ISLAND.height * short;
  const left = screen.x + (screen.width - width) / 2, top = screen.y + ISLAND.top * short;
  roundedRect(context, left, top, width, height, height / 2);
  context.fillStyle = '#000';
  context.fill();
  const lens = { x: left + width - height / 2, y: top + height / 2, r: height * 0.22 };
  context.beginPath();
  context.arc(lens.x, lens.y, lens.r, 0, Math.PI * 2);
  context.fillStyle = '#0b0d14';
  context.fill();
  context.lineWidth = Math.max(0.5, lens.r * 0.25);
  context.strokeStyle = '#1c2233';
  context.stroke();
  context.beginPath();
  context.arc(lens.x - lens.r * 0.3, lens.y - lens.r * 0.3, lens.r * 0.22, 0, Math.PI * 2);
  context.fillStyle = '#4a5878';
  context.fill();
}

/** What a framed recording is put together from, the movie being the one
 *  thing that moves: `under`, the frame painted with nothing in the window;
 *  `mask`, solid where the movie shows -- the window below its title bar,
 *  within its rounded corners; and `over`, what goes over the movie, a
 *  phone's island, if anything does -- with where the movie's top left goes.
 *  `scale` paints them smaller, as the editor's preview does. */
export function framePlates(geometry: FrameGeometry, style: FrameStyle, image: { width: number; height: number; dark: boolean }, scale = 1) {
  const canvas = () => Object.assign(document.createElement('canvas'),
    { width: Math.max(1, Math.round(geometry.width * scale)), height: Math.max(1, Math.round(geometry.height * scale)) });
  const scaled = (target: HTMLCanvasElement) => { const context = target.getContext('2d')!; context.scale(scale, scale); return context; };
  const under = canvas(), mask = canvas();
  paintFrame(scaled(under), geometry, { ...style, island: false }, image, () => {});
  const window = windowOf(geometry, image);
  const context = scaled(mask);
  roundedRect(context, window.x, window.y, window.width, window.height, window.radius);
  context.clip();
  context.fillStyle = '#fff';
  context.fillRect(window.x, window.y + geometry.bar, image.width, image.height);
  let over: HTMLCanvasElement | undefined;
  if (style.device === 'phone' && style.island) {
    over = canvas();
    paintIsland(scaled(over), { x: window.x, y: window.y, width: window.width, height: window.height });
  }
  return { under, mask, over, x: window.x, y: window.y + geometry.bar };
}
