/** Copy first, dismiss second. A failed copy must leave the capture where it
 *  is, or a clipboard that refused the image also loses it. */
export async function copyThenDismiss(copy: () => Promise<void>, dismiss: () => void): Promise<void> {
  await copy();
  dismiss();
}
