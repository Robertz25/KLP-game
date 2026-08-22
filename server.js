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
const files = {'/':'lobby.html','/lobby.html':'lobby.html','/controller.html':'phone.html','/klp_arena_poc.html':'klp_arena_poc.html'};
const colors = ['#df614d','#3d77a8','#3e996b','#e1ad2f'];
const lanAddress = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).find(item => item.address.startsWith('10.'))?.address || Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal)[0]?.address || 'localhost';

function send(client, message) { if (client?.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message)); }
function roomPlayers(room) { return [...room.clients.values()].filter(client => client.role === 'player'); }
function announce(room) { room.clients.forEach(client => send(client, {type:'players', players:roomPlayers(room).map(player => ({id:player.id,name:player.name,color:player.color})), started:room.started})); }
function newCode() { let code; do code=crypto.randomBytes(2).toString('hex').toUpperCase(); while(rooms.has(code)); return code; }

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/qr') return QRCode.toBuffer(url.searchParams.get('data') || '', {width:320, margin:2}, (error, buffer) => { if(error){response.writeHead(500);return response.end('QR unavailable');} response.writeHead(200, {'Content-Type':'image/png','Cache-Control':'no-store'}); response.end(buffer); });
  const filename = files[url.pathname];
  if (!filename) { response.writeHead(404); return response.end('Not found'); }
  fs.readFile(path.join(root, filename), 'utf8', (error, page) => {
    if (error) { response.writeHead(500); return response.end('File unavailable'); }
    if (filename === 'lobby.html') { page=page.replace('<div class="players"', '<img id="qr" alt="Scan to join KLP Arena" style="display:none;width:min(260px,80vw);margin:18px auto 8px;background:white;padding:10px;border-radius:4px"><div class="players"'); page = page.replace('</body>', `<script>const qrCodeEl=document.querySelector('#code'),qrImage=document.querySelector('#qr'),refreshQr=()=>{if(qrCodeEl.textContent.trim()!=='----'){qrImage.src='/qr?data='+encodeURIComponent('http://${lanAddress}:${port}/controller.html?room='+qrCodeEl.textContent.trim());qrImage.style.display='block'}};new MutationObserver(refreshQr).observe(qrCodeEl,{childList:true});refreshQr();</script></body>`); }
    if (filename === 'phone.html') page = page.replace('<style>body', '<style>.eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;color:#1f7a59;margin-bottom:6px}.wrap{padding:14px 0}.wrap h1{margin:0 0 8px;font-size:34px}.controller{justify-content:flex-start!important;gap:8px!important}.controller #name{padding:10px!important;margin:0!important;height:46px!important;min-height:46px!important;font:16px Georgia,serif}.controller #save{padding:10px!important;margin:0!important;height:42px!important;min-height:42px!important;background:#1f7a59}.controller .joystick{margin:24px auto 14px}.controller .bomb{margin:8px auto 0}body').replace('<main class="wrap"><h1>KLP Arena</h1>', '<main class="wrap"><div class="eyebrow">KLP ARENA · PHONE CONTROLLER</div><h1>KLP Arena</h1>').replace('window.onpointerup=stop;', '').replace("name.style.display='block';save.style.display='block';dead.style.display='none';contact.style.display='none';thanks.style.display='none';status.textContent='New round'", "dead.textContent='You are out';dead.style.display='none';contact.style.display='none';thanks.style.display='none';status.textContent='New round'");
    if (filename === 'phone.html') page = page.replace("name.style.display='block';save.style.display='block';", "name.style.display='none';save.style.display='none';");
    if (filename === 'phone.html') page = page.replace("if(m.type==='player-dead'){", "if(m.type==='player-dead'||m.type==='player-won'){dead.textContent=m.type==='player-won'?'You won!':'You are out';");
    if (filename === 'phone.html') page = page.replace("save.onclick=()=>send('rename',{name:name.value.trim()});", "save.onclick=()=>{if(name.value.trim()){send('rename',{name:name.value.trim()});name.style.display='none';save.style.display='none';}};");
    if (filename === 'phone.html') page = page.replace('</body>', '<script>(function(){const submittedKey="klp-arena-contact-submitted",form=document.querySelector("#contact"),death=document.querySelector("#dead"),thanks=document.querySelector("#thanks");if(!form)return;const alreadySubmitted=()=>localStorage.getItem(submittedKey)==="true";const showThankYou=()=>{if(!alreadySubmitted())return;form.style.display="none";if(death){death.style.display="none";death.textContent="You are out"}if(thanks)thanks.style.display="block"};form.addEventListener("submit",()=>{localStorage.setItem(submittedKey,"true")});new MutationObserver(showThankYou).observe(form,{attributes:true,attributeFilter:["style"]});showThankYou()})();</script></body>');
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); response.end(page);
  });
});

const wss = new WebSocket.Server({server});
wss.on('connection', socket => {
  const client = {socket, role:null, room:null, id:null, name:'Guest', color:null};
  socket.on('message', raw => {
    let message; try { message=JSON.parse(raw); } catch { return; }
    if (message.type === 'create') { const code=newCode(); const room={code,host:client,clients:new Map([['host',client]]),started:false,createdAt:Date.now()}; client.role='host';client.room=room;client.id='host';rooms.set(code,room);send(client,{type:'created',room:code});announce(room);return; }
    if (message.type === 'join') { const room=rooms.get(String(message.room||'').toUpperCase()); if(!room||room.started||roomPlayers(room).length>=4)return send(client,{type:'error',message:'Room is unavailable or full.'}); const number=roomPlayers(room).length+1;client.role='player';client.room=room;client.id='p'+number;client.name=String(message.name||'Guest').slice(0,30);client.color=colors[number-1];room.clients.set(client.id,client);send(client,{type:'joined',id:client.id,color:client.color});announce(room);return; }
    if (message.type === 'host-reconnect') {
      const requestedRoom = String(message.room || '').toUpperCase();
      const room = requestedRoom === 'AUTO' ? [...rooms.values()].sort((a,b) => b.createdAt - a.createdAt).find(item => !item.host || item.started) : rooms.get(requestedRoom);
      if (!room) return send(client, {type:'error', message:'Room no longer exists.'});
      client.role='host'; client.room=room; client.id='host'; room.host=client; room.started=true; room.clients.set('host',client);
      return send(client, {type:'reconnected', started:true, humanIds:roomPlayers(room).map(player => Number(player.id.slice(1)))});
    }
    if (!client.room) return;
    if (message.type === 'start' && client.role === 'host') { client.room.started=true;announce(client.room);client.room.clients.forEach(member=>send(member,{type:'start'}));return; }
    if (message.type === 'restart' && client.role === 'host') { client.room.clients.forEach(member=>send(member,{type:'restart'}));return; }
    if (message.type === 'rename' && client.role === 'player') { client.name=String(message.name||'Guest').slice(0,30);announce(client.room);return; }
    if (message.type === 'contact' && client.role === 'player') { console.log(`Contact form received from ${client.name}:`,message.details);return; }
    if (message.type === 'player-dead' && client.role === 'host') { const player=client.room.clients.get(message.playerKey);if(player)send(player,{type:'player-dead'});return; }
    if (message.type === 'player-won' && client.role === 'host') { const player=client.room.clients.get(message.playerKey);if(player)send(player,{type:'player-won'});return; }
    if (message.type === 'input' && client.role === 'player' && client.room.host) send(client.room.host,{type:'remote-input',id:client.id,input:message.input});
  });
  socket.on('close',()=>{if(!client.room)return;const room=client.room;room.clients.delete(client.id);if(client.role==='host')room.host=null;else announce(room);if(room.clients.size===0)rooms.delete(room.code);});
});
server.listen(port,'0.0.0.0',()=>{console.log(`KLP Arena host: http://localhost:${port}`);console.log(`Phone controllers: http://${lanAddress}:${port}/controller.html`);});
