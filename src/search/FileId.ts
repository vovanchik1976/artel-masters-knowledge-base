/** Public file IDs have a separate input; catalogue filters never apply. */
export function parseFileId(input: string): number | null {
  const match = /^(?:#|id)?([0-9]+)$/i.exec(input.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}
