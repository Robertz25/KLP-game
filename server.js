const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const WebSocket = require('ws');
const { Pool } = require('pg');

// Optional Postgres storage for the post-game "leave your details" form. Only enabled when
// DATABASE_URL is set (e.g. on Render, where a linked Postgres database injects this env var
// automatically). Locally, without DATABASE_URL, contact submissions are just logged instead
// of crashing the server.
const databaseUrl = (process.env.DATABASE_URL || '').trim();
const pool = databaseUrl ? new Pool({
    connectionString: databaseUrl,
    // Render's managed Postgres requires SSL; rejectUnauthorized:false avoids needing the CA cert.
    ssl: { rejectUnauthorized: false }
}) : null;
if (pool) {
    pool.query(`CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name TEXT,
        company TEXT,
        phone TEXT,
        score INTEGER,
        room TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
    )`).then(() =>
        // Table may already exist from before "company" was added — patch it in-place instead
        // of requiring a manual migration.
        pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT')
    ).then(() => console.log('[db] contacts table ready')).catch(err => console.error('[db] failed to create contacts table', err));
} else {
    console.warn('[db] DATABASE_URL not set — contact form submissions will only be logged, not stored');
}
async function saveContact({ name, company, phone, score, room }) {
    if (!pool) {
        console.log('[contact] (no DATABASE_URL, not saved)', { name, company, phone, score, room });
        return;
    }
    try {
        await pool.query(
            'INSERT INTO contacts (name, company, phone, score, room) VALUES ($1, $2, $3, $4, $5)',
            [name, company, phone, score, room]
        );
    } catch (err) {
        console.error('[db] failed to save contact', err);
    }
}

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const rooms = new Map();
// Monotonically increasing counter stamped onto a client whenever it newly claims a slot
// (fresh join, or being pulled off the queue into a freed slot) — but deliberately NOT
// bumped on a same-client `rejoin` (grace-period reconnect), since that's still the same
// occupant resuming, not a new one. The host's `players` broadcast includes this per-slot
// `gen`, which is how the game engine (js/klp-arena-engine.js) tells "a different real
// person just took over this slot id" apart from "the same slot id is still assigned to
// the same person as before" — both cases otherwise look identical (same `pN` id), which
// used to make a queued player who got auto-admitted into a slot freed by a death
// silently stay stuck under bot AI control (see knownHumanIds/knownHumanGens usage).
let nextSlotGen = 1;
const files = {
    '/': 'klp_arena_rev.html',
    '/lobby.html': 'lobby.html',
    '/controller.html': 'phone.html',
    '/phone.html': 'phone.html',
    '/klp_arena_poc.html': 'klp_arena_rev.html',
    '/klp_arena_rev.html': 'klp_arena_rev.html'
};
// The core game engine now lives in its own external script (kept as plain JS, loaded via
// a <script src> tag) instead of being inlined into the HTML page.
const scriptFiles = {
    '/js/klp-arena-engine.js': 'js/klp-arena-engine.js'
};
const colors = ['#df614d', '#3d77a8', '#3e996b', '#e1ad2f', '#9b59b6', '#16a3a3'];
// The arena page always keeps a minimum of this many fish (humans + bots) in play,
// so the room needs this many joinable slots.
const maxSlots = 6;

// Auto-detecting "the" LAN address is inherently a guess whenever a machine has more than
// one non-internal network interface — which is extremely common (VPN clients, Docker,
// Tailscale/ZeroTier, macOS's AWDL/AirDrop interface, etc. all show up as valid, non-internal
// IPv4 addresses). The previous heuristic actively preferred addresses starting with "10.",
// which is backwards: 10.0.0.0/8 is one of the *most common ranges corporate/VPN clients use*,
// while home/office Wi-Fi routers overwhelmingly hand out 192.168.x.x (and some 172.16-31.x.x).
// Baking a VPN-only address into the QR code meant a phone on the same Wi-Fi as the host
// could never actually reach it — exactly the "QR sends me to a page I can't reach" bug.
// This instead (1) skips interfaces that are almost never the same LAN a phone is on, and
// (2) ranks the remaining candidates by how likely they are to be a real local Wi-Fi/LAN
// address, only falling back to "first available" as a last resort.
const virtualInterfacePattern = /^(utun|tun|tap|ppp|awdl|llw|vmnet|vboxnet|docker|veth|br-|zt|tailscale|wg)/i;
function rankLanCandidate(address) {
    if (/^192\.168\./.test(address)) return 0; // typical home/office Wi-Fi
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 1; // common router/AP default range
    if (/^10\./.test(address)) return 2; // common, but also the most common VPN range
    return 3;
}
function detectLanAddress() {
    const override = (process.env.LAN_HOST || '').trim();
    if (override) return override;
    const candidates = Object.entries(os.networkInterfaces())
        .filter(([name]) => !virtualInterfacePattern.test(name))
        .flatMap(([, addresses]) => addresses || [])
        .filter(item => item && item.family === 'IPv4' && !item.internal);
    if (!candidates.length) return 'localhost';
    candidates.sort((a, b) => rankLanCandidate(a.address) - rankLanCandidate(b.address));
    return candidates[0].address;
}
const lanAddress = detectLanAddress();

// LAN-address detection is still only a guess, and plenty of real-world networks (hotel/office/
// campus Wi-Fi, "guest" networks, some home routers) enable *client/AP isolation*, which blocks
// two devices from reaching each other directly even when they're on the same subnet with the
// right IP — this is indistinguishable from "the QR is wrong" from the user's side, but no
// LAN-address heuristic can ever fix it, since the network itself is refusing the connection.
// To make the QR join flow actually reliable regardless of that, we opportunistically start a
// Cloudflare "quick tunnel" (`cloudflared tunnel --url ...`), which publishes this server at a
// temporary public HTTPS address that routes over the internet instead of the local network —
// so it keeps working even when phone-to-laptop LAN traffic is blocked. This is best-effort and
// silently falls back to the plain LAN address if cloudflared isn't installed, has no internet,
// or simply doesn't print a URL in time; the LAN QR flow above is untouched either way.
let publicOrigin = null;
let tunnelStatus = 'disabled';
function startQuickTunnel() {
    if (process.env.NO_TUNNEL) { tunnelStatus = 'disabled'; return; }
    tunnelStatus = 'starting';
    let child;
    try {
        child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error) {
        tunnelStatus = 'unavailable';
        return;
    }
    let settled = false;
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const onData = chunk => {
        if (settled) return;
        const text = chunk.toString();
        const match = text.match(urlPattern);
        if (match) {
            settled = true;
            publicOrigin = match[0];
            tunnelStatus = 'connected';
            console.log(`Public join link ready: ${publicOrigin}`);
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => { if (!settled) tunnelStatus = 'unavailable'; });
    child.on('exit', () => {
        if (!settled) tunnelStatus = 'unavailable';
        publicOrigin = null;
    });
    // cloudflared normally prints its assigned URL within a couple of seconds; if it hasn't by
    // 12s (slow network, first-run binary check, etc.) treat it as unavailable rather than
    // leaving the lobby waiting indefinitely — the LAN address is still perfectly usable.
    setTimeout(() => { if (!settled) tunnelStatus = 'unavailable'; }, 12000);
}
startQuickTunnel();

function send(client, message) {
    if (client?.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
}

function roomPlayers(room) {
    return [...room.clients.values()].filter(client => client.role === 'player');
}

function roomSlots(room) {
    const humans = new Map(roomPlayers(room).map(player => [Number(player.id.slice(1)), player]));
    return Array.from({length: maxSlots}, (_, index) => {
        const slot = index + 1;
        const player = humans.get(slot);
        return player ? {
            id: player.id,
            name: player.name,
            color: player.color,
            kind: 'human'
        } : {
            id: `p${slot}`,
            name: `BOT ${slot}`,
            color: colors[index] || '#888',
            kind: 'bot'
        };
    });
}

function roomQueue(room) {
    return room.queue || [];
}

// Sends every waiting client their live position in line (1-based) plus how many people
// are ahead of them, so the phone can show "You're #2 in line" instead of a static message.
function broadcastQueue(room) {
    roomQueue(room).forEach((queued, index) => send(queued, {
        type: 'queued',
        position: index + 1,
        total: roomQueue(room).length
    }));
}

function announce(room) {
    const queueInfo = roomQueue(room).map((queued, index) => ({
        name: queued.name,
        position: index + 1
    }));
    room.clients.forEach(client => send(client, {
        type: 'players',
        players: roomPlayers(room).map(player => ({id: player.id, name: player.name, color: player.color, gen: player.gen})),
        slots: roomSlots(room),
        queue: queueInfo,
        started: room.started
    }));
    broadcastQueue(room);
}

// Pulls the next waiting client (if any) into the just-freed slot id (e.g. 'p3'), handing
// them the fish that a dead/disconnected player (or bot) previously occupied.
function admitFromQueue(room, freedId) {
    if (room.clients.has(freedId)) return; // slot got reused already
    const next = roomQueue(room).shift();
    if (!next) return;
    const number = Number(freedId.slice(1));
    next.role = 'player';
    next.room = room;
    next.id = freedId;
    next.color = colors[number - 1] || '#888';
    next.lastInputAt = Date.now();
    next.gen = nextSlotGen++;
    room.clients.set(freedId, next);
    console.warn('WS queue admit', {room: room.code, id: freedId, name: next.name});
    send(next, {type: 'joined', id: next.id, color: next.color});
    if (room.started) send(next, {type: 'start'});
}

// Some phones never send a clean WebSocket close (backgrounded tab, locked screen, OS
// suspending the page) — the socket just goes quiet forever without the normal 20s
// disconnect grace period ever kicking in. That left their fish sitting frozen on the
// board ("uncontrolled" from everyone else's point of view) forever. This sweep frees
// any player slot that hasn't sent an `input` in IDLE_KICK_MS: if someone's waiting in
// the queue they take the slot immediately, otherwise the host (see klp-arena-engine.js's
// 'players' handler) notices the slot is no longer in the human list and hands it back
// to a bot, so a fish is never just left sitting there uncontrolled.
const IDLE_KICK_MS = Number(process.env.IDLE_KICK_MS) || 15000;
function sweepIdlePlayers() {
    const now = Date.now();
    rooms.forEach(room => {
        let changed = false;
        for (const [id, client] of room.clients) {
            if (client.role !== 'player' || !/^p\d+$/.test(id)) continue;
            if (now - (client.lastInputAt || 0) > IDLE_KICK_MS) {
                console.warn('WS idle player kicked', {room: room.code, id, name: client.name});
                room.clients.delete(id);
                client.role = 'spectator';
                send(client, {
                    type: 'idle-kicked',
                    message: 'You were moved out of the game due to inactivity. Rejoin to play again.'
                });
                admitFromQueue(room, id);
                changed = true;
            }
        }
        if (changed) announce(room);
    });
}
setInterval(sweepIdlePlayers, Number(process.env.IDLE_SWEEP_MS) || 5000);

function newCode() {
    let code;
    do code = crypto.randomBytes(2).toString('hex').toUpperCase(); while (rooms.has(code));
    return code;
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/net-info') {
        response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        // Prefer the request's public-facing origin (host + proto) when available so
        // deployed instances show their public URL instead of the server's internal LAN IP.
        const forwardedProto = request.headers['x-forwarded-proto'] || (request.socket && request.socket.encrypted ? 'https' : 'http');
        const hostHeader = String(request.headers.host || '');
        const hostOrigin = hostHeader ? `${forwardedProto}://${hostHeader}` : null;
        const lan = /^(localhost|127\.0\.0\.1|\[::1])(:\d+)?$/i.test(hostHeader)
            ? `http://${lanAddress}:${port}`
            : (hostOrigin || `http://${lanAddress}:${port}`);
        return response.end(JSON.stringify({
            lanOrigin: lan,
            publicOrigin,
            tunnelStatus
        }));
    }
    if (url.pathname === '/api/top-scores') {
        response.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        if (!pool) return response.end(JSON.stringify({scores: []}));
        return pool.query(
            'SELECT name, company, score FROM contacts WHERE score IS NOT NULL ORDER BY score DESC, created_at DESC LIMIT 5'
        ).then(({rows}) => response.end(JSON.stringify({scores: rows})))
            .catch(err => {
                console.error('[db] failed to fetch top scores', err);
                response.end(JSON.stringify({scores: []}));
            });
    }
    if (url.pathname === '/qr') return QRCode.toBuffer(url.searchParams.get('data') || '', {
        width: 320,
        margin: 2
    }, (error, buffer) => {
        if (error) {
            response.writeHead(500);
            return response.end('QR unavailable');
        }
        response.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'});
        response.end(buffer);
    });
    const scriptFilename = scriptFiles[url.pathname];
    if (scriptFilename) {
        return fs.readFile(path.join(root, scriptFilename), 'utf8', (error, script) => {
            if (error) {
                response.writeHead(500);
                return response.end('File unavailable');
            }
            response.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
            response.end(script);
        });
    }
    const filename = files[url.pathname];
    if (!filename) {
        response.writeHead(404);
        return response.end('Not found');
    }
    fs.readFile(path.join(root, filename), 'utf8', (error, page) => {
        if (error) {
            response.writeHead(500);
            return response.end('File unavailable');
        }
        if (filename === 'phone.html') page = page.replace('<style>body', '<style>.eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;color:#1f7a59;margin-bottom:6px}.wrap{padding:14px 0}.wrap h1{margin:0 0 8px;font-size:34px}.controller{justify-content:flex-start!important;gap:8px!important}.controller #name{padding:10px!important;margin:0!important;height:46px!important;min-height:46px!important;font:16px Georgia,serif}.controller #save{padding:10px!important;margin:0!important;height:42px!important;min-height:42px!important;background:#1f7a59}.controller .joystick{margin:24px auto 14px}.controller .bomb{margin:8px auto 0}body').replace('<main class="wrap"><h1>KLP Arena</h1>', '<main class="wrap"><div class="eyebrow">KLP ARENA · PHONE CONTROLLER</div><h1>KLP Arena</h1>').replace('window.onpointerup=stop;', '').replace("name.style.display='block';save.style.display='block';dead.style.display='none';contact.style.display='none';thanks.style.display='none';status.textContent='New round'", "dead.textContent='You are out';dead.style.display='none';contact.style.display='none';thanks.style.display='none';status.textContent='New round'");
        if (filename === 'phone.html') page = page.replace("name.style.display='block';save.style.display='block';", "name.style.display='none';save.style.display='none';");
        if (filename === 'phone.html') page = page.replace("if(m.type==='player-dead'){", "if(m.type==='player-dead'||m.type==='player-won'){dead.textContent=m.type==='player-won'?'You won!':'You are out';");
        if (filename === 'phone.html') page = page.replace("save.onclick=()=>send('rename',{name:name.value.trim()});", "save.onclick=()=>{if(name.value.trim()){send('rename',{name:name.value.trim()});name.style.display='none';save.style.display='none';}};");
        // When the lobby or game page is opened via localhost/127.0.0.1 (typical when running the
        // server locally), the QR code would otherwise encode "localhost", which a phone on
        // the same Wi-Fi network cannot resolve to the host machine. Inject the detected LAN
        // IP address so the QR/link points somewhere the phone can actually reach. The page also
        // polls /net-info afterwards to pick up a public tunnel URL (see startQuickTunnel above)
        // once cloudflared finishes connecting, since that happens asynchronously after startup.
        if (filename === 'lobby.html' || filename === 'klp_arena_rev.html' || filename === 'klp_arena_poc.html') {
            const hostHeader = String(request.headers.host || '');
            const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1])(:\d+)?$/i.test(hostHeader);
            if (isLocalhost && lanAddress && lanAddress !== 'localhost') {
                // Match the first `<script` tag regardless of attributes (the game page's
                // engine script now loads via `<script src="...">` instead of being inlined),
                // inserting a small inline script just before it that sets the LAN origin.
                page = page.replace(/<script/, `<script>window.LAN_ORIGIN='http://${lanAddress}:${port}';</script><script`);
            }
        }
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        response.end(page);
    });
});

const wss = new WebSocket.Server({server});
wss.on('connection', socket => {
    const client = {socket, role: null, room: null, id: null, name: 'Guest', color: null, lastInputAt: Date.now()};
    socket.on('message', raw => {
            let message;
            try {
                message = JSON.parse(raw);
            } catch (e) {
                console.warn('WS: failed to parse message', e);
                return;
            }
        if (message.type === 'create') {
            const code = newCode();
            const room = {
                code,
                host: client,
                clients: new Map([['host', client]]),
                // The game page no longer has a separate lobby/"Start Game" step — the
                // arena is live and running continuously the moment the room is created —
                // so mark it started right away. Otherwise `started` would stay false
                // forever (nothing ever sends the old 'start' message anymore), which broke
                // the "new player takes over the leading bot" slot-picking below and left
                // joining players' phones stuck without the "Game started" state.
                started: true,
                createdAt: Date.now(),
                queue: []
            };
            client.role = 'host';
            client.room = room;
            client.id = 'host';
            rooms.set(code, room);
            send(client, {type: 'created', room: code});
            announce(room);
            return;
        }
        if (message.type === 'join') {
            const room = rooms.get(String(message.room || '').toUpperCase());
            if (!room) {
                console.warn('WS join rejected', {room: message.room, exists: false});
                // Distinct wording from the "room full" case below so a stale/expired QR code
                // (e.g. from an old session, or a room the host abandoned by reloading) isn't
                // misread by the player as "the room is full" when it simply no longer exists.
                return send(client, {
                    type: 'error',
                    message: 'Room not found. Ask the host for a fresh QR code.'
                });
            }
            // Continuous mode: a slot with no connected player client is being driven by a
            // bot in the game view. Joining mid-match takes over such a slot instead of being
            // rejected — and if several are free, prefer the one currently in the lead (the
            // "leading bot"), so a new human always displaces the strongest bot, not a random one.
            const freeSlots = Array.from({length: maxSlots}, (_, i) => i + 1).filter(n => !room.clients.has('p' + n));
            if (!freeSlots.length) {
                // Every fish is already claimed by a human — instead of rejecting the join,
                // put them in a queue and slot them in automatically as soon as somebody
                // dies or disconnects (see admitFromQueue).
                client.role = 'queued';
                client.room = room;
                client.name = String(message.name || 'Guest').slice(0, 30);
                room.queue = room.queue || [];
                room.queue.push(client);
                console.warn('WS join queued: room full', {room: room.code, name: client.name, position: room.queue.length});
                send(client, {type: 'queued', position: room.queue.length, total: room.queue.length});
                announce(room);
                return;
            }
            const percents = room.percents || [];
            const number = room.started
                ? freeSlots.reduce((best, n) => (percents[n - 1] || 0) > (percents[best - 1] || 0) ? n : best, freeSlots[0])
                : freeSlots[0];
            client.role = 'player';
            client.room = room;
            client.id = 'p' + number;
            client.name = String(message.name || 'Guest').slice(0, 30);
            client.color = colors[number - 1] || '#888';
            client.lastInputAt = Date.now();
            client.gen = nextSlotGen++;
            room.clients.set(client.id, client);
            console.warn('WS join', {room: room.code, id: client.id, name: client.name});
            send(client, {type: 'joined', id: client.id, color: client.color});
            if (room.started) send(client, {type: 'start'});
            announce(room);
            return;
        }
        if (message.type === 'rejoin') {
            const room = rooms.get(String(message.room || '').toUpperCase());
            if (!room) {
                console.warn('WS rejoin failed: room not found', {room: message.room, id: message.id});
                return send(client, {type: 'error', message: 'Room no longer exists.'});
            }
            const id = String(message.id || '');
            if (!/^p\d+$/.test(id)) {
                console.warn('WS rejoin failed: invalid id', {room: room.code, id});
                return send(client, {type: 'error', message: 'Invalid reconnect.'});
            }
            const existing = room.clients.get(id);
            if (existing && existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
            const number = Number(id.slice(1));
            client.role = 'player';
            client.room = room;
            client.id = id;
            client.name = (existing && existing.name) || String(message.name || 'Guest').slice(0, 30);
            client.color = colors[number - 1] || (existing && existing.color) || '#888';
            client.lastInputAt = Date.now();
            // A `rejoin` is the *same* occupant resuming after a dropped socket (grace
            // period), not a different person taking over the slot — so it must keep the
            // existing `gen` rather than bumping it. If there's nothing to inherit from
            // (e.g. the slot's original client object was already GC'd), fall back to a
            // fresh gen since there's no prior value to preserve anyway.
            client.gen = (existing && existing.gen) || nextSlotGen++;
            room.clients.set(id, client);
            console.warn('WS rejoin', {room: room.code, id, hadExisting: !!existing, started: room.started});
            send(client, {type: 'joined', id: client.id, color: client.color});
            if (room.started) send(client, {type: 'start'});
            announce(room);
            return;
        }
        if (message.type === 'host-reconnect') {
            const requestedRoom = String(message.room || '').toUpperCase();
            // AUTO is only a fallback for when the caller doesn't know its own room code (e.g. an
            // old bookmark/link with just "?host=1"). It must never take over a room that already
            // has a live host attached, or it can silently hijack an active match: the previous
            // condition (`!item.host || item.started`) was always true once every room is marked
            // `started` at creation time, so AUTO effectively grabbed the single most-recently-created
            // room on the whole server, host or no host — which is exactly what caused a real host's
            // room to be stolen out from under it, leaving players' input routed nowhere and any new
            // joiner stuck looking at a different, already-full room.
            const room = requestedRoom === 'AUTO' ? [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).find(item => !item.host) : rooms.get(requestedRoom);
            if (!room) return send(client, {type: 'error', message: 'Room no longer exists.'});
            // Cancel any pending "abandoned room" cleanup now that a host has actually
            // reconnected to it.
            if (room.hostGoneTimer) { clearTimeout(room.hostGoneTimer); room.hostGoneTimer = null; }
            client.role = 'host';
            client.room = room;
            client.id = 'host';
            room.host = client;
            room.started = true;
            room.clients.set('host', client);
            send(client, {
                type: 'reconnected',
                room: room.code,
                started: true,
                humanIds: roomPlayers(room).map(player => Number(player.id.slice(1)))
            });
            announce(room);
            return;
        }
        if (!client.room) return;
        if (message.type === 'start' && client.role === 'host') {
            client.room.started = true;
            announce(client.room);
            client.room.clients.forEach(member => send(member, {type: 'start'}));
            return;
        }
        if (message.type === 'restart' && client.role === 'host') {
            client.room.clients.forEach(member => send(member, {type: 'restart'}));
            return;
        }
        if (message.type === 'rename' && client.role === 'player') {
            client.name = String(message.name || 'Guest').slice(0, 30);
            announce(client.room);
            return;
        }
        if (message.type === 'contact') {
            const details = message.details || {};
            const room = client.room;
            saveContact({
                name: String(details.name || '').slice(0, 100),
                company: String(details.company || '').slice(0, 120),
                phone: String(details.phone || '').slice(0, 30),
                score: Number.isFinite(client.lastScore) ? client.lastScore : null,
                room: room ? room.code : null
            }).then(() => {
                // Nudge the host to refresh its "Toppliste" panel immediately.
                if (room && room.host) send(room.host, {type: 'top-scores-updated'});
            });
            return;
        }
        if (message.type === 'player-dead' && client.role === 'host') {
            const room = client.room;
            const player = room.clients.get(message.playerKey);
            if (player) {
                player.lastScore = Number.isFinite(message.score) ? message.score : null;
                send(player, {type: 'player-dead', score: player.lastScore});
                // A dead fish's slot is taken over by a bot on the game board immediately, so
                // free the network slot right away too — that's what lets someone waiting in
                // the queue jump straight into the vacated spot instead of the room staying
                // "full" for the rest of the match even though a human no longer occupies it.
                if (room.clients.get(message.playerKey) === player) {
                    room.clients.delete(message.playerKey);
                    player.role = 'spectator';
                }
                admitFromQueue(room, message.playerKey);
                announce(room);
            }
            return;
        }
        if (message.type === 'player-won' && client.role === 'host') {
            const player = client.room.clients.get(message.playerKey);
            if (player) {
                player.lastScore = Number.isFinite(message.score) ? message.score : null;
                send(player, {type: 'player-won', score: player.lastScore});
            }
            return;
        }
        if (message.type === 'freeze-offer' && client.role === 'host') {
            const player = client.room.clients.get(message.playerKey);
            if (player) send(player, {type: 'freeze-offer', options: message.options});
            return;
        }
        if (message.type === 'freeze-pick' && client.role === 'player') {
            if (client.room.host) send(client.room.host, {type: 'freeze-pick', by: client.id, targetKey: message.targetKey});
            return;
        }
        // Host periodically reports each slot's territory %, used above to pick the
        // "leading bot" slot to hand over when a new player joins a running match.
        if (message.type === 'territory' && client.role === 'host') {
            client.room.percents = Array.isArray(message.percents) ? message.percents : client.room.percents;
            return;
        }
        if (message.type === 'input' && client.role === 'player' && client.room.host) {
            client.lastInputAt = Date.now();
            send(client.room.host, {
                type: 'remote-input',
                id: client.id,
                input: message.input
            });
        }
        // Host requests room closure: kick all players and delete room
        if (message.type === 'close-room' && client.role === 'host') {
            const room = client.room;
            if (room) {
                room.clients.forEach((c, id) => {
                    if (id !== 'host') {
                        send(c, {type: 'room-closed', message: 'Host closed the room.'});
                        try { c.socket.close(); } catch (e) { }
                    }
                });
                roomQueue(room).forEach(c => {
                    send(c, {type: 'room-closed', message: 'Host closed the room.'});
                    try { c.socket.close(); } catch (e) { }
                });
                room.queue = [];
                rooms.delete(room.code);
                // clear host association
                room.clients.clear();
                client.room = null;
                client.role = null;
                send(client, {type: 'closed'});
            }
            return;
        }
    });
    socket.on('close', () => {
        if (!client.room) return;
        const room = client.room;
        if (client.role === 'host') {
            room.host = null;
            // Clean up abandoned rooms (no players either) after a short grace period, so
            // repeated testing/restarts don't leave stale rooms piling up in memory forever —
            // which otherwise made the AUTO host-reconnect fallback increasingly unreliable
            // the longer the server stayed up.
            if (room.hostGoneTimer) clearTimeout(room.hostGoneTimer);
            room.hostGoneTimer = setTimeout(() => {
                if (!room.host && roomPlayers(room).length === 0 && rooms.get(room.code) === room) {
                    rooms.delete(room.code);
                }
            }, 30000);
            return;
        }
        if (client.role === 'player') {
            // Grace period: keep the player's slot reserved briefly in case of a brief
            // connection drop, so a rejoin can resume the same fish/id instead of
            // being treated as a brand-new player.
            const id = client.id;
            console.warn('WS player disconnected, starting grace period', {room: room.code, id});
            client.reconnectTimer = setTimeout(() => {
                if (room.clients.get(id) === client) {
                    console.warn('WS grace period expired, removing player', {room: room.code, id});
                    room.clients.delete(id);
                    admitFromQueue(room, id);
                    announce(room);
                    if (room.clients.size === 0) rooms.delete(room.code);
                }
            }, 20000);
            return;
        }
        if (client.role === 'queued') {
            room.queue = roomQueue(room).filter(c => c !== client);
            announce(room);
            return;
        }
        // Covers 'spectator' (a player marked dead, whose slot may have already been handed
        // to someone else from the queue) and any other leftover role: only remove this
        // exact client, never a different client that has since taken over the same id.
        if (room.clients.get(client.id) === client) room.clients.delete(client.id);
        if (room.clients.size === 0) rooms.delete(room.code);
    });
});
server.listen(port, '0.0.0.0', () => {
    const bind = `0.0.0.0:${port}`;
    console.log(`Server listening on ${bind}`);
    // Also print the detected LAN IP and any public tunnel URL so it's obvious which
    // addresses can be used to reach the server from other devices.
    console.log(`Detected LAN address: http://${lanAddress}:${port}`);
    if (publicOrigin) console.log(`Public tunnel URL: ${publicOrigin}`);
    console.log(`Localhost: http://localhost:${port}`);
});
