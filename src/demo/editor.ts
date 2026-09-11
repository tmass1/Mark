import { installBridge } from './bridge';
installBridge('editor');
// Only now: platform.ts decides isTauri when it is first evaluated.
await import('../main');
