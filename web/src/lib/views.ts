/** Turns the inline "Name this view" form into the /views body, or a plain error. */
export function viewNameRequest<S>(table: string, name: string, state: S): { body: { table: string; name: string; state: S } } | { error: string } {
  const n = name.trim();
  return n ? { body: { table, name: n, state } } : { error: "Add a name." };
}
