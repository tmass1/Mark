import { installBridge } from './bridge';
installBridge('recording');
// Only now: platform.ts decides isTauri when it is first evaluated.
await import('../recording');
