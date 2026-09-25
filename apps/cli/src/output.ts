export function print(json: boolean, value: unknown, table?: () => string): void {
  if (json || !table) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${table()}\n`);
  }
}

export function rows(header: string[], data: string[][]): string {
  const all = [header, ...data];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...data.map(line)].join('\n');
}
