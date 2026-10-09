import { installBridge } from './bridge';
const host = installBridge('selector') as typeof import('./page').host;
// Rust hands the overlay its display, any armed delay, the windows on screen
// and whether to start out picking one, through globals.
window.__MARK_DISPLAY__ = host.display();
window.__MARK_DELAY__ = host.delay();
window.__MARK_WINDOWS__ = host.windows();
window.__MARK_MODE__ = host.mode();
await import('../selector');
