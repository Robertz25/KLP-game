const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const WebSocket = require('ws');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const rooms = new Map();
const files = {
    '/': 'lobby.html',
    '/lobby.html': 'lobby.html',
    '/controller.html': 'phone.html',
    '/klp_arena_poc.html': 'klp_arena_rev.html'
};
const colors = ['#df614d', '#3d77a8', '#3e996b', '#e1ad2f'];
const lanAddress = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).find(item => item.address.startsWith('10.'))?.address || Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal)[0]?.address || 'localhost';

function send(client, message) {
    if (client?.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
}

function roomPlayers(room) {
    return [...room.clients.values()].filter(client => client.role === 'player');
}

function announce(room) {
    room.clients.forEach(client => send(client, {
        type: 'players',
        players: roomPlayers(room).map(player => ({id: player.id, name: player.name, color: player.color})),
        started: room.started
    }));
}

function newCode() {
    let code;
    do code = crypto.randomBytes(2).toString('hex').toUpperCase(); while (rooms.has(code));
    return code;
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
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
        if (filename === 'phone.html') page = page.replace('</body>', '<script>(function(){const submittedKey="klp-arena-contact-submitted",form=document.querySelector("#contact"),death=document.querySelector("#dead"),thanks=document.querySelector("#thanks");if(!form)return;const alreadySubmitted=()=>localStorage.getItem(submittedKey)==="true";const showThankYou=()=>{if(!alreadySubmitted())return;form.style.display="none";if(death){death.style.display="none";death.textContent="You are out"}if(thanks)thanks.style.display="block"};form.addEventListener("submit",()=>{localStorage.setItem(submittedKey,"true")});new MutationObserver(showThankYou).observe(form,{attributes:true,attributeFilter:["style"]});showThankYou()})();</script></body>');
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        response.end(page);
    });
});

const wss = new WebSocket.Server({server});
wss.on('connection', socket => {
    const client = {socket, role: null, room: null, id: null, name: 'Guest', color: null};
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
                started: false,
                createdAt: Date.now()
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
            if (!room || room.started || roomPlayers(room).length >= 4) {
                console.warn('WS join rejected', {room: message.room, exists: !!room, started: room?.started, count: room ? roomPlayers(room).length : 0});
                return send(client, {
                    type: 'error',
                    message: 'Room is unavailable or full.'
                });
            }
            const number = roomPlayers(room).length + 1;
            client.role = 'player';
            client.room = room;
            client.id = 'p' + number;
            client.name = String(message.name || 'Guest').slice(0, 30);
            client.color = colors[number - 1] || '#888';
            room.clients.set(client.id, client);
            console.warn('WS join', {room: room.code, id: client.id, name: client.name});
            send(client, {type: 'joined', id: client.id, color: client.color});
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
            room.clients.set(id, client);
            console.warn('WS rejoin', {room: room.code, id, hadExisting: !!existing, started: room.started});
            send(client, {type: 'joined', id: client.id, color: client.color});
            if (room.started) send(client, {type: 'start'});
            announce(room);
            return;
        }
        if (message.type === 'host-reconnect') {
            const requestedRoom = String(message.room || '').toUpperCase();
            const room = requestedRoom === 'AUTO' ? [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).find(item => !item.host || item.started) : rooms.get(requestedRoom);
            if (!room) return send(client, {type: 'error', message: 'Room no longer exists.'});
            client.role = 'host';
            client.room = room;
            client.id = 'host';
            room.host = client;
            room.started = true;
            room.clients.set('host', client);
            send(client, {
                type: 'reconnected',
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
        if (message.type === 'contact' && client.role === 'player') {
            return;
        }
        if (message.type === 'player-dead' && client.role === 'host') {
            const player = client.room.clients.get(message.playerKey);
            if (player) send(player, {type: 'player-dead'});
            return;
        }
        if (message.type === 'player-won' && client.role === 'host') {
            const player = client.room.clients.get(message.playerKey);
            if (player) send(player, {type: 'player-won'});
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
        if (message.type === 'input' && client.role === 'player' && client.room.host) send(client.room.host, {
            type: 'remote-input',
            id: client.id,
            input: message.input
        });
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
                    announce(room);
                    if (room.clients.size === 0) rooms.delete(room.code);
                }
            }, 20000);
            return;
        }
        room.clients.delete(client.id);
        if (room.clients.size === 0) rooms.delete(room.code);
    });
});
server.listen(port, '0.0.0.0', () => {
});
