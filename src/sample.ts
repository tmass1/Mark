import type { CapturePreview } from './platform';

/** Local fixture for the browser preview only. Never included in native capture state. */
export function sampleCapture(): CapturePreview {
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 740;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e9eef2'; ctx.fillRect(0, 0, 1200, 740);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(86, 82, 1028, 576, 24); ctx.fill();
  ctx.fillStyle = '#202124'; ctx.font = '600 48px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('A little more clarity.', 150, 264);
  ctx.fillStyle = '#64656c'; ctx.font = '28px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('Capture the detail. Keep the context.', 150, 323);
  ctx.fillStyle = '#007aff'; ctx.beginPath(); ctx.roundRect(150, 421, 226, 64, 12); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = '500 24px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('Ready to share', 180, 462);
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}
