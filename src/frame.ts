/** Frame: the capture set on a background, with room around it, rounded
 *  corners, a shadow and, if wanted, a window's title bar -- the way a
 *  screenshot is dressed to be shown to someone rather than pasted into a bug.
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
  /** A title bar with the three lights across the top of the image. */
  chrome: boolean;
}

export const DEFAULT_FRAME: FrameStyle = { on: false, background: 'sky', padding: 0.5, radius: 0.4, shadow: 0.5, chrome: false };

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
    chrome: flag(given.chrome, DEFAULT_FRAME.chrome),
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

/** Where everything goes, in image pixels. */
export interface FrameGeometry {
  /** The whole framed image. */
  width: number; height: number;
  /** Background showing around the window, the same on every side. */
  pad: number;
  /** The title bar's height; 0 without one. */
  bar: number;
  /** The window's corner radius. */
  radius: number;
  shadow: { blur: number; y: number; alpha: number };
}

/** The sliders' 0 to 1 turned into pixels. The unit is the square root of the
 *  image's area: between its sides, so a long thin capture is neither
 *  smothered nor given a hairline. Whole pixels throughout, so the image lands
 *  on the grid and stays sharp. */
export function frameGeometry(width: number, height: number, density: number, style: FrameStyle): FrameGeometry {
  const unit = Math.sqrt(width * height);
  const pad = Math.round(style.padding * 0.16 * unit);
  const bar = style.chrome ? Math.round(BAR * Math.max(1, density)) : 0;
  const radius = Math.min(Math.round(style.radius * 0.035 * unit), Math.floor(Math.min(width, height + bar) / 2));
  const shadow = style.shadow > 0
    ? { blur: Math.round(style.shadow * 0.07 * unit), y: Math.round(style.shadow * 0.025 * unit), alpha: 0.22 + 0.28 * style.shadow }
    : { blur: 0, y: 0, alpha: 0 };
  return { width: width + 2 * pad, height: height + bar + 2 * pad, pad, bar, radius, shadow };
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

/** The framed image: background, the window's shadow, then the window itself
 *  -- title bar and image -- clipped to its rounded corners. `draw` puts the
 *  image and its marks down with the origin at the image's top left. */
export function paintFrame(context: CanvasRenderingContext2D, geometry: FrameGeometry, style: FrameStyle,
                           image: { width: number; height: number; dark: boolean }, draw: () => void) {
  const { pad, bar, radius, shadow } = geometry;
  paintBackground(context, backgroundOf(style.background), geometry.width, geometry.height);
  const x = pad, y = pad, width = image.width, height = image.height + bar;
  if (shadow.alpha > 0 && (shadow.blur > 0 || shadow.y > 0)) {
    // Cast by a shape drawn wholly off the canvas, its shadow offset back on:
    // so the shadow lands and the shape never does, and a window's transparent
    // corners show the background rather than a fill behind them.
    const away = geometry.width + geometry.height + shadow.blur * 4;
    context.save();
    context.shadowColor = `rgba(0, 0, 0, ${shadow.alpha.toFixed(3)})`;
    context.shadowBlur = shadow.blur;
    context.shadowOffsetX = away;
    context.shadowOffsetY = shadow.y;
    context.fillStyle = '#000';
    roundedRect(context, x - away, y, width, height, radius);
    context.fill();
    context.restore();
  }
  context.save();
  roundedRect(context, x, y, width, height, radius);
  context.clip();
  if (bar) {
    const colours = image.dark ? BAR_COLOURS.dark : BAR_COLOURS.light;
    context.fillStyle = colours.fill;
    context.fillRect(x, y, width, bar);
    const scale = bar / BAR;
    context.fillStyle = colours.line;
    context.fillRect(x, y + bar - Math.max(1, Math.round(scale)), width, Math.max(1, Math.round(scale)));
    for (const light of LIGHTS) {
      context.beginPath();
      context.arc(x + light.x * scale, y + bar / 2, (LIGHT_RADIUS - 0.25) * scale, 0, Math.PI * 2);
      context.fillStyle = light.fill;
      context.fill();
      context.lineWidth = 0.5 * scale;
      context.strokeStyle = light.edge;
      context.stroke();
    }
  }
  context.translate(x, y + bar);
  draw();
  context.restore();
}
