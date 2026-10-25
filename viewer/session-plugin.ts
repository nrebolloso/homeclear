import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Local demo relay. The headset owns state; companions submit commands, never overwrite snapshots.
export function sessionRelayPlugin(): Plugin {
  type Peer = { response: ServerResponse; role: string };
  type Room = { host?: string; peers: Map<string, Peer>; state?: string; revision: number; touched: number };
  const rooms = new Map<string, Room>();
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/api\/session\/([\w-]{3,48})$/.exec(url.pathname); if (!match) return next();
    const id = url.searchParams.get('client') ?? '', role = url.searchParams.get('role');
    if (!/^[\w-]{8,64}$/.test(id)) { res.statusCode = 400; res.end('Invalid client'); return; }
    for (const [key, room] of rooms) if (!room.peers.size && Date.now() - room.touched > 900000) rooms.delete(key);
    if (!rooms.has(match[1]) && rooms.size >= 50) { res.statusCode = 503; res.end('Session limit'); return; }
    const room: Room = rooms.get(match[1]) ?? { peers: new Map(), revision: 0, touched: Date.now() }; rooms.set(match[1], room); room.touched = Date.now();
    if (req.method === 'GET') {
      if (role !== 'host' && role !== 'companion' || role === 'host' && room.host && room.host !== id) { res.statusCode = 409; res.end('Session already has a host'); return; }
      if (role === 'host') room.host = id;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n'); room.peers.set(id, { response: res, role });
      if (room.state && role === 'companion') res.write(room.state);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { clearInterval(heartbeat); room.peers.delete(id); if (room.host === id) room.host = undefined; room.touched = Date.now(); });
      return;
    }
    if (req.method !== 'POST' || !room.peers.has(id)) { res.statusCode = 403; res.end('Join session first'); return; }
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', chunk => { size += chunk.length; if (size > 1048576) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      try {
        const packet = JSON.parse(Buffer.concat(chunks).toString());
        if (!['state', 'pose', 'command', 'ack'].includes(packet.kind) || (packet.kind !== 'command' && room.host !== id) || (packet.kind === 'command' && room.peers.get(id)?.role !== 'companion')) { res.statusCode = 403; res.end('Unsupported session message'); return; }
        const encoded = `id: ${++room.revision}\ndata: ${JSON.stringify({ ...packet, sender: id, revision: room.revision })}\n\n`;
        if (packet.kind === 'state') room.state = encoded;
        for (const [peerId, peer] of room.peers) if (peerId !== id) peer.response.write(encoded);
        res.end('ok');
      } catch { res.statusCode = 400; res.end('Invalid session message'); }
    });
  }
  return { name: 'companion-session-relay', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
