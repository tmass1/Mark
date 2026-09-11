import { installBridge } from './bridge';
const host = installBridge('selector') as typeof import('./page').host;
// Rust hands the overlay its display and any armed delay through globals.
window.__MARK_DISPLAY__ = host.display();
window.__MARK_DELAY__ = host.delay();
await import('../selector');
