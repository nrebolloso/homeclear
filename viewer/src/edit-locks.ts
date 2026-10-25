// A held VR object and a pending desktop edit cannot own the same object.
export function createEditLocks() {
  const held = new Map<string, string>();
  return {
    owner: (key: string) => held.get(key) ?? held.get('*'),
    busy: () => held.size > 0,
    acquire(key: string, owner: string) {
      if (key === '*' ? [...held.values()].some(v => v !== owner) : held.has('*') && held.get('*') !== owner || held.has(key) && held.get(key) !== owner) return false;
      held.set(key, owner); return true;
    },
    release(key: string, owner: string) { if (held.get(key) === owner) held.delete(key); },
    async run<T>(key: string, owner: string, task: () => Promise<T> | T): Promise<T> {
      if (!this.acquire(key, owner)) throw Error('This object is being edited by the other viewer. Try again after release.');
      try { return await task(); } finally { this.release(key, owner); }
    },
  };
}
