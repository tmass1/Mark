/** The name macOS itself would give a screenshot, so a saved or dragged file
 *  lands somewhere recognisable in a folder full of them. */
export function suggestedName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Mark ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
}
