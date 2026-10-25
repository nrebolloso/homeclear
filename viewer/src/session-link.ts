// Session transport is independent of room lifetimes. Only the host applies edits.
export function createSessionLink(D: { game(): any; scan(): string; switchScan(id: string): Promise<boolean>; status(text: string): void }) {
  const id = crypto.randomUUID(); let connection: EventSource | null = null, endpoint = '', role = '', signature = '', applying = false, timer = 0, busy = false;
  let latest: any = null, commandQueue = Promise.resolve(); const originals = new WeakMap<object, Record<string, any>>(); const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
  const post = async (packet: unknown) => { const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(packet) }); if (!response.ok) throw Error(await response.text()); };
  async function request(action: string, args: unknown[] = []) {
    if (!connection || role !== 'companion') throw Error('Join a companion session first');
    while (busy) await new Promise(resolve => setTimeout(resolve, 25));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => { pending.delete(requestId); reject(Error('Host did not respond; reconnect before retrying.')); }, 60000);
      pending.set(requestId, { resolve, reject, timer: timeout });
      void post({ kind: 'command', requestId, scene: D.scan(), baseKey: D.game()?.layoutKey(), action, args }).catch(error => { clearTimeout(timeout); pending.delete(requestId); reject(error); });
    });
  }
  async function applyLatest() {
    if (busy || !latest) return; busy = true;
    try {
      while (latest) {
        const packet = latest; latest = null; applying = true;
        if (D.scan() !== packet.scene && !await D.switchScan(packet.scene)) throw Error('Host scan could not be loaded on this device');
        const game = D.game(); attach(game);
        await game.restoreSession(packet.state);
        game.setVision(packet.vision); game.setNight(packet.night); game.remoteHead = packet.head;
        D.status('Connected to host · room synchronized');
      }
    } catch (error) { D.status(String(error)); } finally { applying = false; busy = false; }
  }
  function attach(game: any) {
    if (!game) return; game.remoteSession = role === 'companion';
    if (role !== 'companion') { const original = originals.get(game); if (original) { Object.assign(game, original); originals.delete(game); game.__sessionWrapped = false; } return; }
    if (game.__sessionWrapped) return;
    originals.set(game, Object.fromEntries(['moveObject', 'removeObject', 'restoreObject', 'applyPreparedOption', 'recenter', 'history', 'sharedEdit', 'suggest'].map(key => [key, game[key]])));
    game.__sessionWrapped = true;
    for (const method of ['moveObject', 'removeObject', 'restoreObject', 'applyPreparedOption', 'recenter', 'suggest']) game[method] = (...args: unknown[]) => request(method, args);
    game.history = { undo: () => request('undo'), redo: () => request('redo') };
    game.sharedEdit = (_name: string, task: () => unknown) => task();
  }
  async function execute(packet: any) {
    const game = D.game(); let value: unknown;
    try {
      if (packet.scene !== D.scan() || packet.baseKey !== game.layoutKey()) throw Error('The host room changed. Wait for synchronization and retry.');
      const args = Array.isArray(packet.args) ? packet.args : [];
      if (packet.action === 'scan' && typeof args[0] === 'string') value = await D.switchScan(args[0]);
      else if (['moveObject', 'removeObject', 'restoreObject'].includes(packet.action) && typeof args[0] === 'string' && game.items.includes(args[0])) {
        if (packet.action === 'moveObject' && (args.length !== 4 || !args.slice(1).every(Number.isFinite))) throw Error('Invalid object pose');
        value = await game.sharedEdit(args[0], () => game[packet.action](...args));
      } else if (packet.action === 'undo' || packet.action === 'redo') value = await game.history[packet.action]();
      else if (packet.action === 'suggest') value = await game.suggest();
      else if (packet.action === 'applyPreparedOption' && Number.isInteger(args[0])) value = await game.editLocks.run('*', 'desktop', () => game.applyPreparedOption(args[0]));
      else if (packet.action === 'recenter') value = game.recenter();
      else throw Error('This action must be prepared on the host');
      signature = ''; await post({ kind: 'ack', requestId: packet.requestId, value });
    } catch (error) { await post({ kind: 'ack', requestId: packet.requestId, error: String(error) }); }
  }
  function disconnect() {
    connection?.close(); connection = null; clearInterval(timer); role = ''; latest = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Session disconnected')); } pending.clear();
    if (D.game()) attach(D.game());
    D.status('Session disconnected. Editing this device locally.');
  }
  function connect(code: string, nextRole: string) {
    if (!/^[\w-]{3,48}$/.test(code) || !['host', 'companion'].includes(nextRole)) throw Error('Use a session name of 3–48 letters, numbers or hyphens.');
    disconnect(); role = nextRole; signature = ''; endpoint = `/api/session/${code}?client=${id}&role=${role}`;
    connection = new EventSource(endpoint); attach(D.game());
    connection.onopen = () => D.status(`Connected as ${role}: ${code}`);
    connection.onerror = () => D.status('Session connection interrupted; reconnecting…');
    connection.onmessage = event => {
      const packet = JSON.parse(event.data);
      if (packet.kind === 'ack') { const entry = pending.get(packet.requestId); if (entry) { clearTimeout(entry.timer); pending.delete(packet.requestId); packet.error ? entry.reject(Error(packet.error)) : entry.resolve(packet.value); } }
      else if (role === 'host' && packet.kind === 'command') commandQueue = commandQueue.then(() => execute(packet)).catch(error => D.status(String(error)));
      else if (role === 'companion' && packet.kind === 'state') { latest = packet; void applyLatest(); }
      else if (role === 'companion' && packet.kind === 'pose' && D.game()) D.game().remoteHead = packet.head;
    };
    timer = window.setInterval(() => {
      const game = D.game(); if (role !== 'host' || !game?.ready || game.sessionBusy || game.pending()) return;
      const state = game.saveSession(), head = game.xrPose().userCam;
      const next = JSON.stringify([D.scan(), state.layout, state.applied, state.personaKey, state.selRoute, (document.getElementById('vision') as HTMLSelectElement)?.value, (document.getElementById('night') as HTMLInputElement)?.checked]);
      const packet = next === signature ? { kind: 'pose', head } : { kind: 'state', scene: D.scan(), state, head, vision: (document.getElementById('vision') as HTMLSelectElement)?.value ?? 'normal', night: (document.getElementById('night') as HTMLInputElement)?.checked ?? false };
      void post(packet).then(() => signature = next).catch(error => D.status(String(error)));
    }, 500);
  }
  return { connect, disconnect, attach, request, role: () => role, applying: () => applying };
}
