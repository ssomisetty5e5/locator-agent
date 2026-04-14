// Simple UID generator without external dependencies

let counter = 0;

/**
 * Generate a simple unique id for each discovered element.
 */
export function v4Fallback(index: number): string {
  counter++;
  const ts = Date.now().toString(36);
  const idx = index.toString(36).padStart(4, '0');
  const cnt = counter.toString(36).padStart(4, '0');
  return `el-${ts}-${idx}-${cnt}`;
}

export function resetCounter(): void {
  counter = 0;
}
