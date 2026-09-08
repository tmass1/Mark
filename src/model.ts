export interface EditorSize { width: number; height: number }

export function validEditorSize(value: unknown): EditorSize | null {
  if (!value || typeof value !== 'object') return null;
  const { width, height } = value as Partial<EditorSize>;
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 380 || height < 280 || width > 4000 || height > 3000) return null;
  return { width, height };
}
export async function copyThenDismiss(copy: () => Promise<void>, dismiss: () => void): Promise<void> {
  await copy();
  dismiss();
}
