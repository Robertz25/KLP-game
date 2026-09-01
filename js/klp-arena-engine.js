(() => {
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      // This is a shared-screen party game (one TV/host screen plus up to 5 phone
      // controllers), so every fish must always stay visible on the one shared canvas —
      // a panning "follow one player" camera would let the other fish wander outside the
      // visible area even though they're still safely inside the map. Instead, the whole
      // board is always rendered at once, scaled down (and letterboxed) to fit the canvas.
      const cols = 130, rows = 80, tile = 16;
      const viewW = 1120, viewH = 672;
      const viewScale = Math.min(viewW / (cols * tile), viewH / (rows * tile));
      const viewOffsetX = (viewW - cols * tile * viewScale) / 2;
      const viewOffsetY = (viewH - rows * tile * viewScale) / 2;
      // Free-for-all always keeps at least 5 fish (human + bots) on the board at once,
      // like paper.io's crowded servers, so a 5th slot/colour/start position is included
      // even though only 4 have local keyboard bindings (the 5th is always bot-driven
      // locally, but can still be taken over by a phone controller).
      const colors = ['#df614d', '#3d77a8', '#3e996b', '#e1ad2f', '#9b59b6'];
      const names = ['RED','BLUE','GREEN','YELLOW','PURPLE'];
      const humanNames = {};
      function playerLabel(id){ const p = players && players[id]; const custom = humanNames[id+1]; return (p && !p.bot && custom) ? custom : names[id]; }
      // Each color/slot always spawns (and respawns, including on a phone taking over a
      // bot slot — see respawnPlayer) at the exact same corner, permanently paired 1:1
      // with `colors`/`names` by array index. The 8-tile inset (rather than the previous
      // 3-4) matters: any tighter and a player who steers straight "into their own corner"
      // (e.g. RED pressing up from the top-left spawn) hits the boundary wall in well
      // under a second, which reads as "the controls don't work" even though it's just
      // the wall.
      const starts = [[8,8],[cols-9,rows-9],[cols-9,8],[8,rows-9],[Math.floor(cols/2),8]];
      const keys = [ {up:'w',down:'s',left:'a',right:'d', bomb:' '}, {up:'arrowup',down:'arrowdown',left:'arrowleft',right:'arrowright', bomb:'enter'}, {up:'i',down:'k',left:'j',right:'l', bomb:'o'}, {up:'t',down:'g',left:'f',right:'h', bomb:'y'}, {up:'8',down:'5',left:'4',right:'6', bomb:'7'} ];
      // Minimum player/bot count: the board is never allowed to have fewer than this many
      // fish in play, so it always feels alive even before any humans join.
      const minPlayers = 5;

      let grid, ownerGrid, players, boosts = [], boostsEnabledAt = 0, round=1, roundOver=false, lastTime=performance.now();
      let isFullscreen = false;
      let freezeItem = null, freezeSpawnAt = 0, freezeSpawned = false;
      const held = new Set();

      // --- Audio: small WebAudio synth stingers, no external assets needed.
      // Browsers block audio before a user gesture, so the context is created lazily on
      // the first key press / click and simply stays suspended until then.
      let audioCtx = null;
      function ensureAudio(){
        if (audioCtx) return audioCtx;
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
        return audioCtx;
      }
      function playTone(freq, duration, type, startGain, opts){
        const ctxA = ensureAudio();
        if (!ctxA) return;
        if (ctxA.state === 'suspended') ctxA.resume();
        const t0 = ctxA.currentTime;
        const osc = ctxA.createOscillator();
        const gain = ctxA.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        if (opts && opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1,opts.sweepTo), t0 + duration);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, startGain || 0.2), t0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        osc.connect(gain); gain.connect(ctxA.destination);
        osc.start(t0); osc.stop(t0 + duration + 0.02);
      }
      // Capture "pop": a short bright upward chirp — the core dopamine hit.
      function playCaptureSound(){ playTone(420, 0.16, 'triangle', 0.22, {sweepTo: 880}); }
      // Kill/death: a low descending stinger.
      function playKillSound(){ playTone(220, 0.32, 'sawtooth', 0.22, {sweepTo: 60}); }
      // Boost pickup: quick rising blip.
      function playBoostSound(){ playTone(600, 0.12, 'square', 0.14, {sweepTo: 1100}); }
      // Freeze pickup: an icy little chime.
      function playFreezeSound(){ playTone(900, 0.2, 'sine', 0.16, {sweepTo: 1400}); }
      // Near-death whoosh: a soft pulse used for the proximity danger warning.
      function playDangerSound(){ playTone(160, 0.14, 'sine', 0.07); }
      window.addEventListener('keydown', () => ensureAudio(), {once:true, capture:true});
      window.addEventListener('pointerdown', () => ensureAudio(), {once:true, capture:true});

      // --- Juice: lightweight particle bursts for captures and kills, purely cosmetic.
      let particles = [];
      function spawnParticles(cx, cy, color, count, opts){
        opts = opts || {};
        for (let i = 0; i < count; i++) {
          const ang = Math.random() * Math.PI * 2;
          const speed = (opts.minSpeed||20) + Math.random() * (opts.maxSpeed||60);
          particles.push({
            x: cx, y: cy,
            vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
            life: 0, maxLife: (opts.life||500) + Math.random() * 200,
            size: (opts.size||2.5) + Math.random() * 2,
            color: color || '#fff'
          });
        }
      }
      function updateParticles(dtMs){
        for (let i = particles.length - 1; i >= 0; i--) {
          const pt = particles[i];
          pt.life += dtMs;
          if (pt.life >= pt.maxLife) { particles.splice(i,1); continue; }
          pt.x += pt.vx * (dtMs/1000);
          pt.y += pt.vy * (dtMs/1000);
          pt.vx *= 0.94; pt.vy *= 0.94;
        }
      }
      function drawParticles(ctx){
        particles.forEach(pt => {
          const t = pt.life / pt.maxLife;
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - t);
          ctx.fillStyle = pt.color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * (1 - t*0.4), 0, Math.PI*2);
          ctx.fill();
          ctx.restore();
        });
      }
      // Quick radial "pop" ring drawn over freshly captured territory.
      let captureRings = [];
      function drawCaptureRings(ctx, now){
        for (let i = captureRings.length - 1; i >= 0; i--) {
          const r = captureRings[i];
          const t = (now - r.start) / r.duration;
          if (t >= 1) { captureRings.splice(i,1); continue; }
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - t) * 0.55;
          ctx.strokeStyle = r.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(r.x, r.y, 10 + t * r.maxRadius, 0, Math.PI*2);
          ctx.stroke();
          ctx.restore();
        }
      }
      const remoteInputs = {};
      const botIds = new Set();
      let networkSocket = null;
      // A host tab that gets reloaded (accidental refresh, browser restart, laptop sleep/
      // wake, etc.) with no ?room= in the URL used to always spin up a brand-new room —
      // silently orphaning every phone that had already joined the old one (their input
      // would go nowhere, and the visible board would show only bots, exactly as if no
      // one had ever joined). Persisting the last room this tab hosted and reattaching to
      // it by default means a reload keeps everyone's slot intact instead of starting over.
      const hostRoomStorageKey = 'klp-fiske-host-room';
      let room = new URLSearchParams(location.search).get('room') || (new URLSearchParams(location.search).get('host') ? 'AUTO' : null);
      if (!room) { try { room = localStorage.getItem(hostRoomStorageKey) || null; } catch (e) { /* ignore */ } }
      let roomCode = (room && room !== 'AUTO') ? room : null;
      const roundDuration = 60 * 1000; // 60s, only used for the local hot-seat (no room) fallback
      let roundStart = performance.now();
      let lastTerritoryReportAt = 0;
      // Continuous mode: once a room is attached (host or joined via QR), the match never
      // ends on a timer or on last-fish-standing — dead slots simply respawn as bots so the
      // board always keeps four fish moving, like paper.io's persistent world.
      let continuous = !!room;
      // Score is a running point total, not a snapshot of current territory %: it only ever
      // goes up, persists across individual respawns/kills for the whole session, and is
      // what the side leaderboard ranks players by. Points are earned by actually capturing
      // land (1 point per tile newly claimed when a loop closes) plus a bonus for eliminating
      // a rival, so bigger, bolder captures are worth more than tiny nibbles at the border.
      const scores = starts.map(()=>0);
      const TILE_POINTS = 1;
      const KILL_BONUS = 30;
      // Human-controlled fish used to snap instantly to whatever direction the held keys
      // pointed, which is what made the trail read as a jagged zig-zag instead of a fish
      // actually turning. Instead, movement now tracks a per-player heading angle that
      // rotates toward the input direction at a capped rate (radians/sec) rather than
      // jumping straight to it, so a hard direction change becomes a gradual, curved turn.
      const TURN_RATE = Math.PI * 1.6;
      // Lifetime total: unlike `scores` (which resets when a fresh, non-continuous round
      // starts), this keeps accumulating forever, saved to localStorage per player slot, so
      // the scoreboard can show an all-time number that survives round restarts and page
      // reloads, not just the current match's score.
      const TOTAL_SCORE_KEY = 'klp-fiske-total-scores';
      function loadTotalScores(){
        try {
          const parsed = JSON.parse(localStorage.getItem(TOTAL_SCORE_KEY));
          if (parsed && Array.isArray(parsed.scores)) {
            return {
              scores: starts.map((_, i) => Number(parsed.scores[i]) || 0),
              names: starts.map((_, i) => (Array.isArray(parsed.names) && parsed.names[i]) || names[i])
            };
          }
          // Older format was a bare array of scores with no attached names.
          if (Array.isArray(parsed)) return { scores: starts.map((_, i) => Number(parsed[i]) || 0), names: starts.map((_, i) => names[i]) };
        } catch (e) { /* corrupt/blocked storage — fall back to zeros */ }
        return { scores: starts.map(() => 0), names: starts.map((_, i) => names[i]) };
      }
      const loadedTotals = loadTotalScores();
      const totalScores = loadedTotals.scores;
      // Name attached to each slot's score history: captured at the moment points are
      // scored (see addScore) rather than looked up live, so a leaderboard/total never
      // silently gets relabeled with someone else's name just because a phone controller
      // renamed itself (or a fresh human took over a bot slot) after those points were
      // already earned.
      const scoreNames = loadedTotals.names;
      function saveTotalScores(){
        try { localStorage.setItem(TOTAL_SCORE_KEY, JSON.stringify({scores: totalScores, names: scoreNames})); } catch (e) { /* storage unavailable */ }
      }
      function addScore(id, amount){
        if (!amount) return;
        scores[id] += amount;
        totalScores[id] += amount;
        scoreNames[id] = playerLabel(id);
        saveTotalScores();
      }

      const hostOverrideKey = 'klp-fiske-host-override';
      function normalizeHostBase(value) {
        const trimmed = String(value || '').trim();
        if (!trimmed) return null;
        return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/$/, '') : `http://${trimmed}`;
      }
      // Same reasoning as the lobby page: a manually-typed address always wins, otherwise
      // prefer whatever public tunnel URL the server managed to open (works over the internet,
      // so it isn't affected by Wi-Fi client/AP isolation the way the guessed LAN IP can be).
      let latestNetInfo = {lanOrigin: window.LAN_ORIGIN || location.origin, publicOrigin: null, tunnelStatus: 'starting'};
      function resolveJoinBase() {
        const manual = normalizeHostBase(localStorage.getItem(hostOverrideKey));
        if (manual) return manual;
        return latestNetInfo.publicOrigin || latestNetInfo.lanOrigin || window.LAN_ORIGIN || location.origin;
      }
      function pollNetInfoForJoinPanel(){
        fetch('/net-info').then(r => r.json()).then(info => {
          latestNetInfo = info;
          updateJoinPanel();
          if (info.tunnelStatus === 'starting') setTimeout(pollNetInfoForJoinPanel, 1500);
        }).catch(() => {});
      }
      pollNetInfoForJoinPanel();
      function updateJoinPanel(){
        const panel = document.getElementById('joinPanel');
        const img = document.getElementById('qrImage');
        if (!panel || !img) return;
        if (roomCode) {
          const base = resolveJoinBase();
          img.src = '/qr?data=' + encodeURIComponent(base + '/phone.html?room=' + roomCode);
          panel.style.display = 'block';
          const hostInput = document.getElementById('hostAddress');
          if (hostInput && document.activeElement !== hostInput) hostInput.value = base.replace(/^https?:\/\//i, '');
          const modeEl = document.getElementById('connectionMode');
          if (modeEl) modeEl.textContent = localStorage.getItem(hostOverrideKey) ? 'Manual address' : (latestNetInfo.publicOrigin ? 'Public link (works on any network)' : 'Local Wi-Fi link');
        } else {
          panel.style.display = 'none';
        }
      }
      (function wireHostAddressOverride(){
        const hostInput = document.getElementById('hostAddress');
        const saveBtn = document.getElementById('saveAddress');
        if (!hostInput || !saveBtn) return;
        const apply = () => {
          const normalized = normalizeHostBase(hostInput.value);
          if (!normalized) return;
          localStorage.setItem(hostOverrideKey, normalized);
          updateJoinPanel();
        };
        saveBtn.addEventListener('click', apply);
        hostInput.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
      })();

      function freshGrid(){
        grid = Array.from({length:rows},()=>Array.from({length:cols},()=>0));
        ownerGrid = Array.from({length:rows},()=>Array.from({length:cols},()=>null));
      }

      // Starting territory: a small round patch of owned ground around the spawn point
      // instead of a single bare tile, so a fresh (or respawned) fish always has a little
      // breathing room to get moving in before it's forced to expose a trail.
      const START_RADIUS = 3;
      function claimStartArea(p, cx, cy){
        const r2 = START_RADIUS * START_RADIUS;
        const minX = Math.max(0, cx - START_RADIUS), maxX = Math.min(cols - 1, cx + START_RADIUS);
        const minY = Math.max(0, cy - START_RADIUS), maxY = Math.min(rows - 1, cy + START_RADIUS);
        for (let yy = minY; yy <= maxY; yy++) {
          for (let xx = minX; xx <= maxX; xx++) {
            const dx = xx - cx, dy = yy - cy;
            if (dx*dx + dy*dy <= r2) ownerGrid[yy][xx] = p.id;
          }
        }
      }

      function reset(){
        freshGrid(); roundOver=false; roundStart=performance.now();
        dangerWasClose = false;
        players = starts.map(([x,y],i)=>({id:i,x:x+.5,y:y+.5,bot:botIds.has(i+1),aiTimer:0,aiDx:0,aiDy:0,speed:7.5,speedBoostUntil:0,frozenUntil:0,trail:[],isOut:false,lastCell:null}));
        boosts = [];
        boostsEnabledAt = performance.now() + 5000;
        freezeItem = null; freezeSpawned = false;
        freezeSpawnAt = roundStart + (1000 + Math.random() * 29000); // 1-30s into the round
        players.forEach(p=>{ claimStartArea(p, Math.floor(p.x), Math.floor(p.y)); });
        if (!continuous) { scores.fill(0); scoreNames.forEach((_, i) => { scoreNames[i] = playerLabel(i); }); }
        updatePanel();
      }

      // Continuous-mode respawn: bring a single slot back to life at its starting corner
      // without touching anyone else's board state, so the match itself never stops.
      function respawnPlayer(p){
        const [x,y] = starts[p.id];
        p.x = x + .5; p.y = y + .5;
        p.trail = []; p.isOut = false; p.frozenUntil = 0; p.speedBoostUntil = 0; p.lastCell = null; p.heading = undefined;
        // freed territory becomes neutral again so it's up for grabs, matching paper.io's
        // rule that a defeated player's land opens back up rather than staying claimed forever.
        for (let yy=0; yy<rows; yy++) for (let xx=0; xx<cols; xx++) if (ownerGrid[yy][xx] === p.id) ownerGrid[yy][xx] = null;
        claimStartArea(p, Math.floor(p.x), Math.floor(p.y));
      }

      function blocked(x,y,who){
        if (x < .22 || y < .22 || x > cols-.22 || y > rows-.22) return true;
        return false;
      }

      // Would moving into grid cell (gx,gy) make p cross its own still-active trail?
      // Self-crossing is now just as fatal as an opponent cutting your trail, so bots use
      // this to steer away from their own tail on purpose. It's not a hard block (movement
      // itself is never restricted by it — a human can still choose to run into their own
      // tail and die) — it's only used to bias the bot's own pathing choices below.
      function wouldSelfCross(p, gx, gy){
        return !!(p.trail && p.trail.length && p.trail.some(c => c.x === gx && c.y === gy));
      }

      // Sweeps every grid cell between a player's previous and new position through
      // enterCell, instead of only checking the final landing cell. A single-cell check
      // is fine at normal speed, but a speed-boosted fish (or a slow/lagging frame with a
      // large dt) can move more than one tile in a step, which let players "tunnel" clean
      // over their own or an opponent's trail without ever landing on one of its cells —
      // the very case that made self-crossing feel like it "didn't count". Stepping
      // through every intermediate cell in order closes that gap.
      function sweepEnterCell(p, now){
        const gx0 = p.lastCell ? p.lastCell.x : Math.floor(p.x);
        const gy0 = p.lastCell ? p.lastCell.y : Math.floor(p.y);
        const gx1 = Math.floor(p.x), gy1 = Math.floor(p.y);
        const dist = Math.max(Math.abs(gx1 - gx0), Math.abs(gy1 - gy0));
        if (dist <= 1) { enterCell(p, gx1, gy1, now); return; }
        for (let i = 1; i <= dist; i++) {
          if (p.isOut) return;
          const t = i / dist;
          enterCell(p, Math.round(gx0 + (gx1 - gx0) * t), Math.round(gy0 + (gy1 - gy0) * t), now);
        }
      }

      // Shared by both human and bot movement: rotates a player's heading toward the
      // desired direction at a capped rate (TURN_RATE) instead of snapping straight to
      // it, so every direction change — human keypress or bot re-targeting alike — reads
      // as a gradual, curved turn rather than an instant corner.
      function advanceHeading(p, desiredAngle, dt){
        if (typeof p.heading !== 'number') p.heading = desiredAngle;
        let diff = desiredAngle - p.heading;
        diff = ((diff + Math.PI) % (Math.PI*2) + Math.PI*2) % (Math.PI*2) - Math.PI;
        const maxTurn = TURN_RATE * dt;
        p.heading += Math.max(-maxTurn, Math.min(maxTurn, diff));
        return p.heading;
      }

      function movePlayer(p,dt,now){
        if (p.isOut) return;
        if (p.frozenUntil && now < p.frozenUntil) { p.vx = 0; p.vy = 0; return; }
        let dx=0,dy=0; const k=keys[p.id];
        if (held.has(k.left)) dx--;
        if (held.has(k.right)) dx++;
        if (held.has(k.up)) dy--;
        if (held.has(k.down)) dy++;
        const remote = remoteInputs[p.id+1];
        if (remote && (now - remote.t) < 600) { dx += remote.x; dy += remote.y; }
        if (!dx && !dy) return;
        const len=Math.hypot(dx,dy)||1; dx/=len; dy/=len;
        // Rotate the fish's actual heading toward the requested direction at a limited
        // turn rate instead of snapping to it — see TURN_RATE above.
        const heading = advanceHeading(p, Math.atan2(dy, dx), dt);
        const hdx = Math.cos(heading), hdy = Math.sin(heading);
        p.vx = hdx; p.vy = hdy;
        const speed = (performance.now() < p.speedBoostUntil) ? p.speed * 1.6 : p.speed;
        const nx = p.x + hdx * speed * dt, ny = p.y + hdy * speed * dt;
        if (!blocked(nx,p.y,p.id)) p.x = nx;
        if (!blocked(p.x,ny,p.id)) p.y = ny;
        sweepEnterCell(p, now);
        collectBoost(p);
        collectFreeze(p, now);
      }

      const homeSpawns = [[2,2],[cols-3,2],[cols-3,rows-3],[2,rows-3],[Math.floor(cols/2),2]];
      function homeSpawn(id){ return homeSpawns[id] || [Math.floor(cols/2), Math.floor(rows/2)]; }
      // How close (in tiles) a rival needs to be before a bot bothers reacting to it at
      // all — outside this range bots ignore other players entirely and just focus on
      // growing their own territory (their actual score), instead of trekking across the
      // whole board to fight someone.
      const BOT_ATTACK_RANGE = 12;
      // A bot won't even consider a frontier tile as an expansion goal unless it's at
      // least this far past its own border. Without this, bots kept beelining for the
      // single nearest unclaimed tile and immediately turning back home, so every capture
      // enclosed only a sliver of land instead of a real chunk of territory.
      const BOT_MIN_REACH = 16;

      function frontierTarget(p){
        const px = Math.floor(p.x);
        const py = Math.floor(p.y);
        const home = homeSpawn(p.id);
        let best = null;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            if (ownerGrid[y][x] === p.id) continue;
            const distance = Math.abs(x - px) + Math.abs(y - py);
            const homeBias = Math.abs(x - home[0]) + Math.abs(y - home[1]);
            const score = distance + homeBias * 0.25;
            if (!best || score < best.score) best = {x, y, score};
          }
        }
        return best;
      }

      // Same idea as frontierTarget, but requires the candidate to be a decent distance
      // past the bot's own border first. This is what actually drives bots to march out
      // and claim a large chunk of land per expedition instead of nibbling right at the
      // edge of territory they already own.
      function botExpansionTarget(p){
        const px = Math.floor(p.x);
        const py = Math.floor(p.y);
        const home = homeSpawn(p.id);
        let best = null;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            if (ownerGrid[y][x] === p.id) continue;
            const distance = Math.abs(x - px) + Math.abs(y - py);
            if (distance < BOT_MIN_REACH) continue;
            const homeBias = Math.abs(x - home[0]) + Math.abs(y - home[1]);
            const score = distance + homeBias * 0.25;
            if (!best || score < best.score) best = {x, y, score};
          }
        }
        return best;
      }

      function spawnBoost(){
        let spot = null;
        for (let tries = 0; tries < 80 && !spot; tries++) {
          const x = 1 + Math.floor(Math.random() * (cols - 2));
          const y = 1 + Math.floor(Math.random() * (rows - 2));
          if (ownerGrid[y][x] === null) spot = {x, y};
        }
        if (spot) boosts.push({x: spot.x, y: spot.y, expiresAt: performance.now() + 10000});
      }

      function collectBoost(p){
        const index = boosts.findIndex(b => Math.hypot(p.x - (b.x + .5), p.y - (b.y + .5)) < .65);
        if (index < 0) return;
        boosts.splice(index, 1);
        p.speedBoostUntil = performance.now() + 2500;
        p.boostStartAt = performance.now();
        playBoostSound();
        spawnParticles(p.x*tile, p.y*tile, '#f2c94c', 12, {life:350, maxSpeed:90, size:2});
        if (Math.random() < .5) spawnBoost();
      }

      function spawnFreeze(){
        let spot = null;
        for (let tries = 0; tries < 80 && !spot; tries++) {
          const x = 1 + Math.floor(Math.random() * (cols - 2));
          const y = 1 + Math.floor(Math.random() * (rows - 2));
          if (ownerGrid[y][x] === null) spot = {x, y};
        }
        if (spot) freezeItem = {x: spot.x, y: spot.y};
      }

      function collectFreeze(p, now){
        if (!freezeItem) return;
        if (Math.hypot(p.x - (freezeItem.x + .5), p.y - (freezeItem.y + .5)) >= .65) return;
        freezeItem = null;
        playFreezeSound();
        spawnParticles(p.x*tile, p.y*tile, '#bdeeff', 12, {life:400, maxSpeed:70, size:2});
        const others = players.filter(x => x.id !== p.id);
        if (!others.length) return;
        if (p.bot) {
          // bots just pick a random opponent to freeze
          const target = others[Math.floor(Math.random() * others.length)];
          target.frozenUntil = now + 2000;
          return;
        }
        if (networkSocket && networkSocket.readyState === WebSocket.OPEN && room) {
          // hand the choice off to the human's phone controller
          networkSocket.send(JSON.stringify({
            type: 'freeze-offer',
            playerKey: `p${p.id+1}`,
            options: others.map(o => ({id: `p${o.id+1}`, color: colors[o.id], name: playerLabel(o.id)}))
          }));
        } else {
          // no phone controller attached (local hot-seat play) — pick a random target
          const target = others[Math.floor(Math.random() * others.length)];
          target.frozenUntil = now + 2000;
        }
      }


      // paper.io-style aggression: look for an opponent currently exposed outside their own
      // territory (i.e. dragging an active trail) *and* close enough to actually be worth
      // reacting to, and aim to cut that trail near its base (the older end, closest to the
      // opponent's own territory) rather than chasing the freshest segment right next to
      // their head. Targeting the head made bots functionally indistinguishable from
      // "ramming" the opponent's body, since the newest trail cell is always wherever the
      // opponent currently is; aiming for the base instead sends bots to intercept the
      // abandoned line from a distance, so the kill genuinely comes from crossing the trail
      // rather than from touching the opponent. Bots prefer hunting other bots when one is
      // exposed, instead of always ganging up on the nearest target (which tended to always
      // be the human, since bots rarely leave their own territory) — this keeps bot-vs-bot
      // fights happening too. Anything further away than BOT_ATTACK_RANGE is ignored so
      // bots don't abandon their own territory to cross the whole map for a fight.
      function huntTarget(p){
        const px = Math.floor(p.x), py = Math.floor(p.y);
        let bestBot = null;
        let bestAny = null;
        for (const other of players) {
          if (other.id === p.id || other.isOut || !other.trail || !other.trail.length) continue;
          // Only consider the base-ward portion of the trail (closest to their territory)
          // so bots cut the line off rather than run down the opponent's tail.
          const cutCount = Math.max(1, Math.ceil(other.trail.length * 0.65));
          const candidates = other.trail.slice(0, cutCount);
          for (const c of candidates) {
            const distance = Math.abs(c.x - px) + Math.abs(c.y - py);
            if (distance > BOT_ATTACK_RANGE) continue;
            const candidate = {x: c.x, y: c.y, distance};
            if (!bestAny || distance < bestAny.distance) bestAny = candidate;
            if (other.bot && (!bestBot || distance < bestBot.distance)) bestBot = candidate;
          }
        }
        if (p.bot && bestBot && Math.random() < 0.6) return bestBot;
        return bestAny;
      }

      // Nearest other active player (regardless of whether they're exposed), used purely as
      // a proximity check so bots only ever react to a rival — attacking or pushing into
      // their land — once that rival is genuinely nearby.
      function nearestOpponent(p){
        const px = Math.floor(p.x), py = Math.floor(p.y);
        let best = null;
        for (const other of players) {
          if (other.id === p.id || other.isOut) continue;
          const distance = Math.abs(Math.floor(other.x) - px) + Math.abs(Math.floor(other.y) - py);
          if (!best || distance < best.distance) best = {other, distance};
        }
        return best;
      }

      // Heads a bot straight back toward its own home corner so a long exposed trail gets
      // banked (captured) instead of risking it further while wandering for more land.
      function returnHomeTarget(p){
        const [hx, hy] = homeSpawn(p.id);
        return {x: hx, y: hy};
      }

      // A lone "go out, then come straight back home" trip retraces almost the same line
      // in both directions, so the loop encloses almost no area (a capture of ~1 tile,
      // regardless of how far the bot travelled) — this is why bots looked like they were
      // wandering without ever actually growing. Adding a sideways leg partway through the
      // expedition (perpendicular to the outbound direction, roughly as far out as the bot
      // already is) turns the trip into a real L-shaped loop, so closing it back up at home
      // encloses a proper chunk of land instead of a sliver.
      function sweepTarget(p){
        const home = homeSpawn(p.id);
        const vx = p.x - home[0], vy = p.y - home[1];
        const len = Math.hypot(vx, vy) || 1;
        const dir = p.aiSweepDir || 1;
        const perpX = -vy / len, perpY = vx / len;
        const dist = Math.max(BOT_MIN_REACH, len);
        const tx = Math.round(Math.max(1, Math.min(cols - 2, p.x + perpX * dist * dir)));
        const ty = Math.round(Math.max(1, Math.min(rows - 2, p.y + perpY * dist * dir)));
        return {x: tx, y: ty};
      }

      // Invasion target used only once a rival is already nearby: the nearest tile owned
      // by that specific rival, so a close-quarters push into their land still reads as a
      // deliberate reaction to their presence rather than a random cross-map raid.
      function rivalTerritoryTarget(p, rivalId){
        const px = Math.floor(p.x), py = Math.floor(p.y);
        let best = null;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const owner = ownerGrid[y][x];
            if (owner === null || owner === p.id || (rivalId != null && owner !== rivalId)) continue;
            const distance = Math.abs(x - px) + Math.abs(y - py);
            if (!best || distance < best.distance) best = {x, y, distance};
          }
        }
        return best;
      }

      // A bot's real goal is score (territory owned), same as a human player's — so by
      // default it just expands its own land like anyone would. Fighting is now a
      // situational reaction rather than the default behaviour: bots only go after another
      // player (cutting an exposed trail, or pushing into their land) once that player is
      // actually close by, and even then territory-hunting still wins most of the time.
      function moveBot(p, dt, now){
              if (p.isOut) return;
              if (p.frozenUntil && now < p.frozenUntil) { return; }
              let target = null;
              const nearby = nearestOpponent(p);
              const isRivalClose = nearby && nearby.distance <= BOT_ATTACK_RANGE;
              // Randomize how far a bot commits to per expedition (re-rolled each time it's
              // back home with an empty trail) so it reliably pushes out far enough to
              // enclose a real chunk of land before banking it, instead of always turning
              // back after a short, timid loop.
              if (!p.trail || !p.trail.length || !p.aiBankAt) {
                p.aiBankAt = 40 + Math.floor(Math.random() * 40);
                p.aiPhase = 'out';
                p.aiSweepDir = Math.random() < 0.5 ? 1 : -1;
                p.aiSweepTarget = null;
              }

              if (isRivalClose) {
                // A rival is exposed (dragging a trail) within striking distance: cut them
                // off. This is the only situation that counts as "attacking".
                const hunt = huntTarget(p);
                if (hunt && Math.random() < 0.75) target = hunt;
                // Otherwise, still nearby but not exposed: occasionally press into their
                // territory to steal land / provoke a fight rather than ignoring them.
                else if (Math.random() < 0.4) target = rivalTerritoryTarget(p, nearby.other.id);
              }

              if (!target && p.trail && !p.isOut) {
                // A straight there-and-back trip retraces almost the same line and encloses
                // almost no area, so an expedition is split into two legs before heading
                // home: first push straight out (phase "out"), then cut sideways roughly
                // perpendicular to that outbound line (phase "sweep") before finally banking
                // the loop (phase "home"). That sideways leg is what turns the trip into a
                // real loop that walls off a meaningful chunk of land.
                if (p.aiPhase === 'out' && p.trail.length > p.aiBankAt * 0.45) {
                  p.aiPhase = 'sweep';
                  p.aiSweepTarget = sweepTarget(p);
                } else if (p.aiPhase === 'sweep' && p.trail.length > p.aiBankAt * 0.85) {
                  p.aiPhase = 'home';
                }
                if (p.aiPhase === 'home') {
                  target = returnHomeTarget(p);
                } else if (p.aiPhase === 'sweep') {
                  target = p.aiSweepTarget || returnHomeTarget(p);
                }
              }

              if (!target && Math.random() < 0.05) {
                // Small chance to break movement patterns/deadlocks with a random unclaimed
                // tile, purely for variety — not the main driver of behaviour anymore.
                const candidates = [];
                for (let y = 1; y < rows-1; y++) for (let x = 1; x < cols-1; x++) if (ownerGrid[y][x] === null && grid[y][x] === 0) candidates.push({x,y});
                if (candidates.length) target = candidates[Math.floor(Math.random()*candidates.length)];
              }

              // Default: grow territory, preferring a target far enough out to enclose a
              // meaningful chunk of land. Crucially, this goal is *cached* on the bot
              // (p.aiExpandTarget) instead of being recalculated from scratch every frame:
              // botExpansionTarget scores candidates using the bot's current position, so
              // recomputing it every tick meant the "nearest tile at least N away" floor
              // moved along with the bot as it walked, and the goalpost effectively never
              // got any closer — bots would jitter almost in place instead of travelling
              // anywhere. Locking onto one target until it's actually reached (or captured
              // out from under them) gives them a stable heading again.
              if (target) {
                p.aiExpandTarget = null;
              } else {
                const cur = p.aiExpandTarget;
                const reached = cur && Math.floor(p.x) === cur.x && Math.floor(p.y) === cur.y;
                const stale = cur && ownerGrid[cur.y][cur.x] === p.id;
                if (!cur || reached || stale) {
                  p.aiExpandTarget = botExpansionTarget(p) || frontierTarget(p) || {x: Math.floor(cols / 2), y: Math.floor(rows / 2)};
                }
                target = p.aiExpandTarget;
              }
              const px = Math.floor(p.x);
              const py = Math.floor(p.y);
              const speedVal = (p.speedBoostUntil && performance.now() < p.speedBoostUntil) ? p.speed * 1.6 : p.speed;
              const moveDist = speedVal * dt;
              // Bots used to only ever step along a single axis at a time (never a true
              // diagonal), which is what made their paths look like a jagged staircase.
              // Instead, steer a continuous heading toward the target — the same gradual,
              // capped-turn-rate smoothing used for human players — so bots curve toward
              // their goal instead of snapping between cardinal directions.
              const desiredAngle = Math.atan2((target.y + .5) - p.y, (target.x + .5) - p.x);
              const heading = advanceHeading(p, desiredAngle, dt);
              const hdx = Math.cos(heading), hdy = Math.sin(heading);
              const nx = p.x + hdx * moveDist, ny = p.y + hdy * moveDist;
              let moved = false;
              // Only commit the smooth move if it doesn't run into a wall or straight over
              // the bot's own trail (self-crossing is fatal — see enterCell) — the same
              // per-axis check movePlayer uses, so a smooth-curving bot can still hug a
              // boundary rather than being blocked outright.
              const safeX = !blocked(nx, p.y, p.id) && !wouldSelfCross(p, Math.floor(nx), Math.floor(p.y));
              const safeY = !blocked(p.x, ny, p.id) && !wouldSelfCross(p, Math.floor(p.x), Math.floor(ny));
              if (safeX) { p.x = nx; moved = true; }
              if (safeY) { p.y = ny; moved = true; }
              if (moved) { p.aiDx = hdx; p.aiDy = hdy; }
        if (!moved) {
          // Fallback: the smooth heading would carry the bot into a wall or its own
          // trail. Fall back to the old discrete, safety-checked cardinal stepping for
          // just this frame, then resync `heading` to whatever direction was actually
          // used so next frame's smoothing resumes from a consistent direction.
          const dx = Math.sign(target.x - px);
          const dy = Math.sign(target.y - py);
          const step = moveDist;
          const tries = [];
          if (Math.abs(target.x - px) > Math.abs(target.y - py)) {
            tries.push([dx, 0], [0, Math.sign(target.y - py)]);
          } else {
            tries.push([0, dy], [Math.sign(target.x - px), 0]);
          }
          tries.push([1,0], [-1,0], [0,1], [0,-1]);
          // Two passes: first only accept moves that don't cross the bot's own trail (self
          // crossing now kills, same as an opponent cutting it), falling back to allowing it
          // only if every option in the preferred directions would do so anyway — better to
          // risk it than to freeze in place.
          for (const avoidSelf of [true, false]) {
            if (moved) break;
            for (const [mx, my] of tries) {
              const tx = p.x + mx * step;
              const ty = p.y + my * step;
              if (mx !== 0 && !blocked(tx, p.y, p.id) && (!avoidSelf || !wouldSelfCross(p, Math.floor(tx), Math.floor(p.y)))) { p.x = tx; moved = true; p.aiDx = mx; p.aiDy = 0; p.heading = Math.atan2(0, mx); break; }
              if (my !== 0 && !blocked(p.x, ty, p.id) && (!avoidSelf || !wouldSelfCross(p, Math.floor(p.x), Math.floor(ty)))) { p.y = ty; moved = true; p.aiDx = 0; p.aiDy = my; p.heading = Math.atan2(my, 0); break; }
            }
          }
          if (!moved) {
            const spread = [[step,0],[-step,0],[0,step],[0,-step]];
            for (const [sx, sy] of spread) {
              const tx = p.x + sx;
              const ty = p.y + sy;
              if (!blocked(tx, ty, p.id)) { p.x = tx; p.y = ty; moved = true; p.aiDx = Math.sign(sx); p.aiDy = Math.sign(sy); p.heading = Math.atan2(sy, sx); break; }
            }
          }
          if (!moved && Math.random() < 0.25) {
            const choices = [[1,0],[-1,0],[0,1],[0,-1]];
            const [fx, fy] = choices[Math.floor(Math.random() * choices.length)];
            const tx = p.x + fx * step;
            const ty = p.y + fy * step;
            if (!blocked(tx, p.y, p.id)) { p.x = tx; p.aiDx = fx; p.aiDy = 0; p.heading = Math.atan2(0, fx); }
            if (!blocked(p.x, ty, p.id)) { p.y = ty; p.aiDx = 0; p.aiDy = fy; p.heading = Math.atan2(fy, 0); }
          }
        }
        sweepEnterCell(p, now);
        collectBoost(p);
        collectFreeze(p, now);
      }

      // Encirclement mechanic: leaving your own territory leaves a trail behind you.
      // Crossing back into your own territory captures every enclosed tile (flood fill
      // from the board edges - anything not reachable from outside stays captured).
      // Crossing an opponent's active trail eliminates them for the round, and cutting
      // your own trail eliminates you the same way — self-collisions are just as fatal
      // as running into someone else's line.
      function enterCell(p, gx, gy, now){
        if (p.isOut || gy < 0 || gy >= rows || gx < 0 || gx >= cols) return;
        // Only process a cell once per actual entry, not on every frame the player
        // happens to still be inside it — otherwise the cell just pushed onto our
        // own trail a moment ago would immediately match the "did I cross a trail"
        // check below and kill the player on the spot they just moved into.
        if (p.lastCell && p.lastCell.x === gx && p.lastCell.y === gy) return;
        p.lastCell = {x: gx, y: gy};
        for (const other of players) {
          if (other.id === p.id) continue;
          if (other.isOut || !other.trail || !other.trail.length) continue;
          if (other.trail.some(c => c.x === gx && c.y === gy)) {
            killPlayer(other, now, p);
          }
        }
        if (ownerGrid[gy][gx] === p.id) {
          if (p.trail.length) captureTerritory(p);
        } else {
          const selfIndex = p.trail.findIndex(c => c.x === gx && c.y === gy);
          if (selfIndex >= 0) {
            // Cutting your own tail is just as fatal as running into someone else's.
            killPlayer(p, now, p);
          } else {
            const last = p.trail[p.trail.length - 1];
            if (!last || last.x !== gx || last.y !== gy) p.trail.push({x: gx, y: gy});
          }
        }
      }

      function captureTerritory(p){
        const trailSet = new Set(p.trail.map(c => c.x + ',' + c.y));
        const isWall = (x,y) => ownerGrid[y][x] === p.id || trailSet.has(x + ',' + y);
        const outside = Array.from({length:rows}, () => new Array(cols).fill(false));
        const stack = [];
        const tryPush = (x,y) => { if (x >= 0 && y >= 0 && x < cols && y < rows && !outside[y][x] && !isWall(x,y)) { outside[y][x] = true; stack.push([x,y]); } };
        for (let x = 0; x < cols; x++) { tryPush(x,0); tryPush(x,rows-1); }
        for (let y = 0; y < rows; y++) { tryPush(0,y); tryPush(cols-1,y); }
        while (stack.length) {
          const [x,y] = stack.pop();
          tryPush(x+1,y); tryPush(x-1,y); tryPush(x,y+1); tryPush(x,y-1);
        }
        let capturedCount = 0, sumX = 0, sumY = 0;
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
          if (isWall(x,y) || !outside[y][x]) {
            if (ownerGrid[y][x] !== p.id) { capturedCount++; sumX += x; sumY += y; }
            ownerGrid[y][x] = p.id;
          }
        }
        // Juice: a bright pop sound plus a radial ring + confetti burst centered on the
        // newly claimed area, so closing a loop feels as good as it does in paper.io 2.
        if (capturedCount > 0 || p.trail.length) {
          playCaptureSound();
          const cx = ((capturedCount ? sumX / capturedCount : p.x) + .5) * tile;
          const cy = ((capturedCount ? sumY / capturedCount : p.y) + .5) * tile;
          captureRings.push({x: cx, y: cy, start: performance.now(), duration: 420, maxRadius: 46, color: colors[p.id] || '#fff'});
          spawnParticles(cx, cy, colors[p.id] || '#fff', 16, {life:450, maxSpeed:110, size:2.4});
        }
        if (capturedCount > 0) addScore(p.id, capturedCount * TILE_POINTS);
        p.trail = [];
      }

      function killPlayer(p, now, killer){
        if (p.isOut) return;
        p.isOut = true;
        p.trail = [];
        p.vx = 0; p.vy = 0;
        // Juice: a low stinger and a burst/fade instead of an instant vanish.
        playKillSound();
        spawnParticles(p.x*tile, p.y*tile, colors[p.id] || '#fff', 22, {life:650, maxSpeed:140, size:3});
        if (killer && killer.id !== p.id) addScore(killer.id, KILL_BONUS);
        if (networkSocket && networkSocket.readyState === WebSocket.OPEN && room && !p.bot) {
          networkSocket.send(JSON.stringify({type: 'player-dead', playerKey: `p${p.id+1}`}));
        }
        if (continuous) {
          // Keep the world alive: a defeated human's slot is taken over by a bot so the
          // board always has four fish in play, and the slot respawns after a short beat.
          if (!p.bot) botIds.add(p.id + 1);
          p.bot = true;
          setTimeout(() => { if (players[p.id] === p) respawnPlayer(p); }, 1500);
        }
      }

      let dangerWasClose = false;

      function tick(dt,now){
        updateParticles(dt*1000);
        if (roundOver) return;
        // purge stale remote inputs
        for (const k in remoteInputs) { if (now - remoteInputs[k].t > 2500) delete remoteInputs[k]; }
        players.forEach(p=>{ if (p.bot) moveBot(p,dt,now); else movePlayer(p,dt,now); });
        for (let i = boosts.length - 1; i >= 0; i--) {
          if (now > boosts[i].expiresAt) boosts.splice(i, 1);
        }
        if (now >= boostsEnabledAt && boosts.length < 4 && Math.random() < 0.018) spawnBoost();
        if (!freezeSpawned && now >= freezeSpawnAt) { spawnFreeze(); freezeSpawned = true; }
        const counts = new Array(players.length).fill(0); let total = 0;
        for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){ total++; const owner = ownerGrid[y][x]; if (owner !== null) counts[owner]++; }
        const percents = counts.map(c => total?Math.round((c/total)*100):0);
        if (continuous) {
          // No round timer, no last-fish-standing ending — the arena just keeps running,
          // and share territory% with the server so it knows which bot is currently leading.
          if (networkSocket && networkSocket.readyState === WebSocket.OPEN && room && now - (lastTerritoryReportAt||0) > 1000) {
            lastTerritoryReportAt = now;
            networkSocket.send(JSON.stringify({type:'territory', percents}));
          }
          return;
        }
        if (now - roundStart >= roundDuration){
          roundOver = true;
          const winnerIndex = percents.indexOf(Math.max(...percents));
          if (networkSocket && networkSocket.readyState===WebSocket.OPEN && players[winnerIndex] && !players[winnerIndex].bot) networkSocket.send(JSON.stringify({type:'player-won',playerKey:`p${winnerIndex+1}`}));
          return;
        }
        const alive = players.filter(p => !p.isOut);
        if (players.length > 1 && alive.length <= 1 && (now - roundStart) > 2000){
          roundOver = true;
          const winner = alive[0];
          if (winner && networkSocket && networkSocket.readyState===WebSocket.OPEN && !winner.bot) networkSocket.send(JSON.stringify({type:'player-won',playerKey:`p${winner.id+1}`}));
        }
      }

      function drawFish(ctx,p,x,y,now){
          ctx.save(); ctx.translate(x,y);
          let ax = 0, ay = 0;
          if (typeof p.aiDx === 'number') { ax = p.aiDx; ay = p.aiDy; }
          if (typeof p.vx === 'number') { ax = p.vx; ay = p.vy; }
          let angle = 0;
          if (Math.abs(ax) > 1e-3 || Math.abs(ay) > 1e-3) angle = Math.atan2(ay, ax);
          const facingLeft = Math.cos(angle) < 0;
          if (facingLeft) { ctx.scale(-1,1); angle = Math.PI - angle; }
          ctx.rotate(angle);
          ctx.fillStyle = 'rgba(22,48,43,.18)'; ctx.beginPath(); ctx.ellipse(0,16,16,6,0,0,Math.PI*2); ctx.fill();
          ctx.fillStyle = colors[p.id] || '#888'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(0,0,18,12,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
          const wag = Math.sin(now/120 + p.id) * 0.6; ctx.save(); ctx.translate(-14,0); ctx.rotate(wag); ctx.fillStyle = colors[p.id] || '#888'; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-12,8); ctx.lineTo(-12,-8); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
          ctx.fillStyle = '#fffdf8'; ctx.beginPath(); ctx.arc(7,-3,3.5,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#18302c'; ctx.beginPath(); ctx.arc(7,-3,1.4,0,Math.PI*2); ctx.fill();
          // mouth: briefly opens wide then closes right after a speed boost is collected
          let mouthOpen = 0;
          if (p.boostStartAt) { const elapsed = now - p.boostStartAt; if (elapsed >= 0 && elapsed < 400) mouthOpen = Math.sin((elapsed / 400) * Math.PI); }
          ctx.strokeStyle = '#18302c'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.arc(15,4,3,0.2,Math.PI-0.2); ctx.stroke();
          if (mouthOpen > 0.05) { ctx.fillStyle = '#18302c'; ctx.beginPath(); ctx.ellipse(15,5,3.2,2+mouthOpen*3.5,0,0,Math.PI*2); ctx.fill(); }
          if (p.speedBoostUntil && performance.now() < p.speedBoostUntil) { ctx.save(); ctx.translate(12,-14); ctx.fillStyle = '#111'; ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(-4,-10); ctx.lineTo(4,-10); ctx.lineTo(-1,-2); ctx.lineTo(6,8); ctx.lineTo(-4,0); ctx.lineTo(2,0); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); }
          if (p.shield){ ctx.strokeStyle='#f2c94c'; ctx.lineWidth=4; ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2); ctx.stroke(); }
          if (p.frozenUntil && now < p.frozenUntil) {
            ctx.fillStyle = 'rgba(150,220,255,.55)'; ctx.strokeStyle='#e8fbff'; ctx.lineWidth=1.5;
            ctx.beginPath(); ctx.ellipse(0,0,20,14,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.3;
            for (let i=0;i<3;i++){ const ang = (Math.PI*2/3)*i; ctx.save(); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(0,-9); ctx.lineTo(0,9); ctx.moveTo(-4,-5); ctx.lineTo(4,-5); ctx.moveTo(-4,5); ctx.lineTo(4,5); ctx.stroke(); ctx.restore(); }
          }
          ctx.restore();
        }
      // Proximity danger warning: pulses a red vignette + arrow toward the nearest active
      // enemy trail once it gets close to the local human, so cheap deaths feel earned
      // (you were warned) rather than unfair, mirroring paper.io 2's tension cues.
      function drawDangerIndicator(now){
        const focus = players.find(pl=>!pl.bot);
        if (!focus || focus.isOut) { dangerWasClose = false; return; }
        let minDist = Infinity, threatAngle = 0;
        for (const other of players) {
          if (other.id === focus.id || other.isOut || !other.trail || !other.trail.length) continue;
          for (const c of other.trail) {
            const d = Math.hypot((c.x+.5) - focus.x, (c.y+.5) - focus.y);
            if (d < minDist) { minDist = d; threatAngle = Math.atan2((c.y+.5)-focus.y, (c.x+.5)-focus.x); }
          }
        }
        const threshold = 4.5;
        if (minDist > threshold) { dangerWasClose = false; return; }
        const intensity = 1 - (minDist / threshold);
        if (!dangerWasClose && intensity > 0.2) { playDangerSound(); dangerWasClose = true; }
        const pulse = 0.5 + 0.5*Math.sin(now/140);
        ctx.save();
        const alpha = intensity * (0.22 + 0.3*pulse);
        const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, Math.min(canvas.width,canvas.height)*0.28, canvas.width/2, canvas.height/2, Math.max(canvas.width,canvas.height)*0.62);
        grad.addColorStop(0, 'rgba(220,40,40,0)');
        grad.addColorStop(1, `rgba(220,40,40,${alpha})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0,0,canvas.width,canvas.height);
        const arrowDist = Math.min(canvas.width, canvas.height)/2 - 30;
        ctx.translate(canvas.width/2 + Math.cos(threatAngle) * arrowDist, canvas.height/2 + Math.sin(threatAngle) * arrowDist);
        ctx.rotate(threatAngle);
        ctx.fillStyle = `rgba(255,80,80,${0.5+0.4*pulse})`;
        ctx.beginPath(); ctx.moveTo(14,0); ctx.lineTo(-10,-9); ctx.lineTo(-10,9); ctx.closePath(); ctx.fill();
        ctx.restore();
      }

      // The board is always fully visible in the main view now (see viewScale above), so a
      // separate "here's where you are in the world" minimap is no longer needed.

      // Territory is still tracked internally as one-tile-per-cell (ownerGrid) for simple,
      // fast collision/flood-fill math, but rendering it as literal filled squares (plus a
      // hairline stroke around every empty tile) is what actually read as "a grid" on
      // screen; stretching a tiny bitmap up with image smoothing just traded the grid for a
      // blur, and covering every owned cell with an oversized circle just traded it for a
      // "bunch of circles" look (visible lobes, especially along thin strips or single
      // outlying cells) instead of one coherent shape. This instead traces the *actual*
      // outline of each player's owned region — walking the boundary between owned and
      // unowned cells to build real polygon(s) (correctly handling multiple disjoint
      // blobs and any holes) — and then rounds every corner of that real outline with a
      // few passes of Chaikin's corner-cutting algorithm. The result follows the true
      // shape of the territory (concave inlets, thin peninsulas, everything) as one smooth
      // curved coastline, rather than approximating it with a pile of primitive shapes.

      // One directed boundary edge per grid-line segment that has owner-cell on one side
      // and not-owner on the other, oriented so the owned cell is always on the right of
      // the direction of travel. Walking these edges tip-to-tail traces closed loops —
      // clockwise for an outer coastline, counter-clockwise for the shore of a hole — which
      // is exactly the winding canvas's default "nonzero" fill rule needs to render holes
      // correctly with a single fill() call.
      function buildOwnerEdgeMaps(){
        const maps = players.map(() => new Map());
        const isOwned = (owner, x, y) => x >= 0 && y >= 0 && x < cols && y < rows && ownerGrid[y][x] === owner;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const owner = ownerGrid[y][x];
            if (owner === null || !maps[owner]) continue;
            const m = maps[owner];
            if (!isOwned(owner, x, y - 1)) m.set(`${x},${y}`, [x + 1, y]);
            if (!isOwned(owner, x + 1, y)) m.set(`${x + 1},${y}`, [x + 1, y + 1]);
            if (!isOwned(owner, x, y + 1)) m.set(`${x + 1},${y + 1}`, [x, y + 1]);
            if (!isOwned(owner, x - 1, y)) m.set(`${x},${y + 1}`, [x, y]);
          }
        }
        return maps;
      }

      function traceLoops(nextMap){
        const visited = new Set();
        const loops = [];
        for (const startKey of nextMap.keys()) {
          if (visited.has(startKey)) continue;
          const loop = [];
          let curKey = startKey;
          while (!visited.has(curKey)) {
            visited.add(curKey);
            const comma = curKey.indexOf(',');
            loop.push(Number(curKey.slice(0, comma)), Number(curKey.slice(comma + 1)));
            const next = nextMap.get(curKey);
            if (!next) break;
            curKey = `${next[0]},${next[1]}`;
          }
          if (loop.length >= 6) loops.push(loop); // at least 3 points
        }
        return loops;
      }

      // Chaikin corner-cutting: replaces every edge of a closed polygon with two points
      // interpolated 1/4 and 3/4 of the way along it. Sharp corners get pulled into a
      // curve over a couple of iterations; long straight runs just gain extra colinear
      // points and stay visually straight.
      function chaikinSmooth(loopFlat, iterations){
        let pts = loopFlat;
        for (let iter = 0; iter < iterations; iter++) {
          const n = pts.length / 2;
          if (n < 3) return pts;
          const out = [];
          for (let i = 0; i < n; i++) {
            const x0 = pts[i*2], y0 = pts[i*2+1];
            const j = (i + 1) % n;
            const x1 = pts[j*2], y1 = pts[j*2+1];
            out.push(x0*0.75 + x1*0.25, y0*0.75 + y1*0.25);
            out.push(x0*0.25 + x1*0.75, y0*0.25 + y1*0.75);
          }
          pts = out;
        }
        return pts;
      }

      function drawTerritory(){
        ctx.fillStyle = '#0f1a1f';
        ctx.fillRect(0, 0, cols * tile, rows * tile);
        const edgeMaps = buildOwnerEdgeMaps();
        edgeMaps.forEach((edgeMap, owner) => {
          if (!edgeMap.size) return;
          const loops = traceLoops(edgeMap);
          if (!loops.length) return;
          ctx.fillStyle = colors[owner] || '#888';
          ctx.beginPath();
          loops.forEach(loop => {
            const px = [];
            for (let i = 0; i < loop.length; i += 2) px.push(loop[i] * tile, loop[i+1] * tile);
            const smooth = chaikinSmooth(px, 2);
            ctx.moveTo(smooth[0], smooth[1]);
            for (let i = 2; i < smooth.length; i += 2) ctx.lineTo(smooth[i], smooth[i+1]);
            ctx.closePath();
          });
          ctx.fill();
        });
      }

      function draw(){ ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle='#07121a'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.save(); ctx.translate(viewOffsetX,viewOffsetY); ctx.scale(viewScale,viewScale);
        drawTerritory();
        // Permanent per-corner labels: every color always spawns (and respawns) at the
        // same corner, so stamping that pairing directly on the board makes it obvious
        // at a glance which fish belongs where — instead of only being visible in the
        // side panel, which can be easy to lose track of once fish are moving around.
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 11px Arial, sans-serif';
        starts.forEach(([sx, sy], id) => {
          const label = names[id];
          const lx = sx * tile, ly = (sy - 1.6) * tile;
          ctx.fillStyle = 'rgba(7,18,26,.72)';
          const w = ctx.measureText(label).width + 12;
          ctx.fillRect(lx - w/2, ly - 9, w, 18);
          ctx.fillStyle = colors[id];
          ctx.fillText(label, lx, ly);
        });
        ctx.restore();
        boosts.forEach(b => {
                  const t = performance.now();
                  const bob = Math.sin(t / 180 + b.x + b.y) * 2;
                  ctx.save();
                  ctx.translate((b.x + .5) * tile, (b.y + .5) * tile + bob);
                  ctx.shadowColor = 'rgba(242,201,76,0.55)';
                  ctx.shadowBlur = 12;
                  ctx.fillStyle = '#111';
                  ctx.beginPath();
                  ctx.moveTo(-6, -8);
                  ctx.lineTo(2, -8);
                  ctx.lineTo(-2, 0);
                  ctx.lineTo(6, 0);
                  ctx.lineTo(-4, 12);
                  ctx.lineTo(-1, 2);
                  ctx.lineTo(-6, 2);
                  ctx.closePath();
                  ctx.fill();
                  ctx.shadowBlur = 0;
                  ctx.strokeStyle = '#f2c94c';
                  ctx.lineWidth = 2.5;
                  ctx.stroke();
                  ctx.restore();
                });
        if (freezeItem) {
          const t = performance.now();
          const bob = Math.sin(t / 180 + freezeItem.x + freezeItem.y) * 2;
          ctx.save();
          ctx.translate((freezeItem.x + .5) * tile, (freezeItem.y + .5) * tile + bob);
          ctx.shadowColor = 'rgba(140,220,255,0.65)';
          ctx.shadowBlur = 12;
          ctx.fillStyle = '#bdeeff';
          ctx.beginPath(); ctx.arc(0,0,9,0,Math.PI*2); ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#0b5c78'; ctx.lineWidth = 1.8; ctx.lineCap='round';
          for (let i=0;i<3;i++){ const ang = (Math.PI/3)*i; ctx.save(); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(0,8); ctx.moveTo(-3.5,-4.5); ctx.lineTo(3.5,-4.5+.001); ctx.moveTo(-3.5,4.5); ctx.lineTo(3.5,4.5); ctx.stroke(); ctx.restore(); }
          ctx.restore();
        }
        players.forEach(p=>{
          if (p.isOut || !p.trail || p.trail.length < 1) return;
          ctx.save();
          ctx.strokeStyle = colors[p.id] || '#888';
          ctx.globalAlpha = .55;
          ctx.lineWidth = tile * .32;
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath();
          // The underlying trail data is still one point per grid cell (needed for the
          // cell-based self/opponent-crossing and capture-flood-fill checks), so drawing it
          // as straight cell-to-cell segments reads as a jagged staircase even though the
          // fish itself now moves and turns smoothly. Instead, curve *through* it: each
          // original trail point becomes the control point of a quadratic curve between
          // the midpoints of its neighbouring segments — a standard cheap way to turn a
          // polyline into a smooth curve without changing (or needing to resample) the
          // underlying point data.
          const pts = p.trail.map(c => [(c.x + .5) * tile, (c.y + .5) * tile]);
          pts.push([p.x * tile, p.y * tile]);
          ctx.moveTo(pts[0][0], pts[0][1]);
          if (pts.length < 3) {
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
          } else {
            for (let i = 1; i < pts.length - 1; i++) {
              const mx = (pts[i][0] + pts[i+1][0]) / 2, my = (pts[i][1] + pts[i+1][1]) / 2;
              ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
            }
            const last = pts[pts.length - 1];
            ctx.lineTo(last[0], last[1]);
          }
          ctx.stroke();
          ctx.restore();
        });
        players.forEach(p=>{ if (p.isOut) return; const x = p.x * tile, y = p.y * tile; drawFish(ctx,p,x,y,performance.now()); });
        drawCaptureRings(ctx, performance.now());
        drawParticles(ctx);
        ctx.restore();
        drawDangerIndicator(performance.now());
        if (isFullscreen && !roundOver) {
          const remaining = Math.max(0, Math.ceil((roundDuration - (performance.now() - roundStart))/1000));
          const label = `${String(Math.floor(remaining/60)).padStart(1,'0')}:${String(remaining%60).padStart(2,'0')}`;
          ctx.save();
          ctx.font = '700 26px Arial';
          const textWidth = ctx.measureText(label).width;
          const pillW = textWidth + 40, pillH = 44, pillX = canvas.width/2 - pillW/2, pillY = 14;
          ctx.fillStyle = 'rgba(7,18,26,.72)';
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(pillX, pillY, pillW, pillH, 22) : ctx.rect(pillX, pillY, pillW, pillH);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = '#fffdf8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(label, canvas.width/2, pillY + pillH/2 + 1);
          ctx.restore();
        }
        if (isFullscreen) {
          const counts = new Array(players.length).fill(0); let total=0;
          for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){ total++; const owner = ownerGrid[y][x]; if (owner!==null) counts[owner]++; }
          ctx.save();
          const rowH = 40, panelW = 168, panelX = canvas.width - panelW - 14; let panelY = 14;
          const panelH = players.length * rowH + 12;
          ctx.fillStyle = 'rgba(7,18,26,.72)';
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(panelX, panelY, panelW, panelH, 16) : ctx.rect(panelX, panelY, panelW, panelH);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5; ctx.stroke();
          players.forEach((p,i)=>{
            const pct = total?Math.round((counts[i]/total)*100):0;
            const rowY = panelY + 6 + i*rowH;
            ctx.fillStyle = colors[p.id] || '#888';
            ctx.beginPath(); ctx.arc(panelX+18, rowY+rowH/2, 7, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle='#000'; ctx.lineWidth=1.5; ctx.stroke();
            ctx.textAlign='left'; ctx.textBaseline='middle'; ctx.fillStyle='#fffdf8';
            ctx.font='700 13px Arial';
            ctx.fillText(`${playerLabel(p.id)}`.slice(0,10), panelX+32, rowY+13);
            ctx.font='700 15px Arial';
            ctx.fillText(`${pct}%`, panelX+32, rowY+29);
            const barX = panelX+80, barW = panelW-96, barY = rowY+23, barH = 6;
            ctx.fillStyle='rgba(255,255,255,.15)'; ctx.fillRect(barX, barY, barW, barH);
            ctx.fillStyle = colors[p.id] || '#888'; ctx.fillRect(barX, barY, barW*(pct/100), barH);
          });
          ctx.restore();
        }
        if (roundOver){ ctx.fillStyle='rgba(24,48,44,.78)'; ctx.fillRect(0,0,canvas.width,canvas.height); const counts = new Array(players.length).fill(0); let total=0; for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){ total++; const owner = ownerGrid[y][x]; if (owner!==null) counts[owner]++; } const percents = counts.map(c => total?Math.round((c/total)*100):0); const winnerIndex = percents.indexOf(Math.max(...percents)); ctx.textAlign='center'; ctx.fillStyle='#fffdf8'; ctx.font='700 38px Georgia'; ctx.fillText(players[winnerIndex]?playerLabel(winnerIndex)+' VINNER':'UAVGJORT', canvas.width/2, canvas.height/2+12); } }

      // Renders the "Venteliste" (queue) panel: everyone waiting for a slot to open up,
      // in the order they'll be admitted (see admitFromQueue in server.js).
      function updateQueuePanel(queue){
        const panel = document.getElementById('queuePanel');
        const el = document.getElementById('queueList');
        if (!panel || !el) return;
        if (!queue || !queue.length) { panel.style.display = 'none'; el.innerHTML = ''; return; }
        panel.style.display = 'block';
        el.innerHTML = queue.map(q => `<div class="player-row"><span class="dot" style="background:#c9d7cc;color:#18302c;display:flex;align-items:center;justify-content:center;font-size:11px">${q.position}</span><div>${q.name}<div class="row-meta">Waiting for a spot</div></div><div></div></div>`).join('');
      }

      function updatePanel(){ const el = document.getElementById('players'); const counts = new Array(players.length).fill(0); let total=0; for (let y=0;y<rows;y++) for (let x=0;x<cols;x++){ total++; const owner = ownerGrid[y][x]; if (owner!==null) counts[owner]++; } el.innerHTML = players.map((p,i)=>{ const pct = total?Math.round((counts[i]/total)*100):0; return `<div class="player-row" style="${p.isOut?'opacity:.45':''}"><span class="dot" style="background:${colors[p.id]}"></span><div>${p.bot?'BOT · ':''}${playerLabel(p.id)}${p.isOut?' · UTE':''}<div class="score-bar"><div class="score-fill" style="width:${pct}%;background:${colors[p.id]}"></div></div></div><div class="player-percent">${pct}%</div></div>`; }).join('');
        const lb = document.getElementById('leaderboard');
        if (lb) {
          const order = players.map((p,i)=>({p,i,score:scores[i],total:totalScores[i]})).sort((a,b)=>b.score-a.score);
          lb.innerHTML = order.map(({p,i,score,total})=>`<div class="player-row"><span class="dot" style="background:${colors[p.id]}"></span><div>${scoreNames[i]}<div class="row-meta">Totalt: ${total.toLocaleString()}</div></div><div class="player-percent">${score.toLocaleString()}</div></div>`).join('');
        }
        const now = performance.now(); const statusEl = document.getElementById('roundStatus');
        if (continuous) { statusEl.textContent = 'LIVE · KONTINUERLIG'; }
        else if (!roundOver){ const remaining = Math.max(0, Math.ceil((roundDuration - (now - roundStart))/1000)); statusEl.textContent = `RUNDE ${round} · ${remaining}s`; } else { statusEl.textContent = `RUNDE ${round} · FERDIG`; } }

      function frame(now){ const dt = Math.min(.035,(now - lastTime)/1000||0); lastTime = now; tick(dt,now); draw(now); updatePanel(); requestAnimationFrame(frame); }

      // Use capture phase and always prevent default for the game's control keys so a
      // focused button (e.g. Restart/Fullscreen) can't be re-triggered by Enter/Space,
      // which previously caused the round to silently reset and look like "movement stopped".
      const controlKeys = new Set(['w','a','s','d',' ','arrowup','arrowdown','arrowleft','arrowright','enter','i','j','k','l','o','t','f','g','h','y']);
      window.addEventListener('keydown', e=>{ const key = e.key.toLowerCase(); held.add(key); if (controlKeys.has(key)) e.preventDefault(); }, true);
      window.addEventListener('keyup', e=>{ const key = e.key.toLowerCase(); held.delete(key); if (controlKeys.has(key)) e.preventDefault(); }, true);

      document.getElementById('restart').addEventListener('click', (e)=>{
        e.currentTarget.blur();
        if (networkSocket?.readyState===WebSocket.OPEN) { networkSocket.send(JSON.stringify({type:'restart'})); }
        else { round++; reset(); }
      });

      document.getElementById('back')?.addEventListener('click', (e)=>{ e.currentTarget.blur(); try{ localStorage.removeItem('klp-fiske-host-room'); }catch(e){} if(networkSocket?.readyState===WebSocket.OPEN){ try{ networkSocket.send(JSON.stringify({type:'close-room'})); }catch(e){} setTimeout(()=>location.href='/',250); } else location.href='/'; });

      // The game page always attaches itself to a live room instead of relying on a
      // separate lobby step: if the URL carries a room/host param we reconnect to that
      // room (e.g. returning host), otherwise we create a brand-new one on the spot so
      // the QR/join panel is ready immediately and phones can join a running arena.
      //
      // The socket is also kept alive across drops (network blip, laptop sleep, a dev
      // server restart) by retrying the same room via 'host-reconnect' instead of just
      // giving up — previously any disconnect here was permanent and silent: the QR
      // stayed on screen pointing at a room whose host was gone, so a phone could still
      // successfully "join" it (the room object lingers for ~30s) but nothing it did
      // would ever reach this page, and the board would never show them taking over a
      // bot. That's indistinguishable from "joining is broken" from the player's side.
      let hostReconnectTimer = null;
      let hostReconnectAttempts = 0;
      function connectNetwork(){
        const socket = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
        networkSocket = socket;
        socket.addEventListener('open', ()=> {
          hostReconnectAttempts = 0;
          socket.send(JSON.stringify(roomCode ? {type:'host-reconnect', room: roomCode} : (room ? {type:'host-reconnect', room} : {type:'create'})));
        });
        socket.addEventListener('close', ()=>{
          if (hostReconnectTimer) return;
          hostReconnectAttempts++;
          const delay = Math.min(5000, 1000 * hostReconnectAttempts);
          hostReconnectTimer = setTimeout(()=>{ hostReconnectTimer = null; connectNetwork(); }, delay);
        });
        socket.addEventListener('message', event=>{
          const message = JSON.parse(event.data);
          if (message.type==='error'){
            // The room we tried to reattach to (e.g. from localStorage/URL) no longer
            // exists server-side — fall back to a fresh room instead of getting stuck
            // with a QR code that will never work.
            roomCode = null;
            try { localStorage.removeItem(hostRoomStorageKey); } catch (e) { /* ignore */ }
            if (networkSocket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'create'}));
            return;
          }
          if (message.type==='created'){ roomCode = message.room; try { localStorage.setItem(hostRoomStorageKey, roomCode); } catch (e) { /* ignore */ } continuous = true; updateJoinPanel(); botIds.clear(); for (let i=1;i<=starts.length;i++) botIds.add(i); reset(); }
          if (message.type==='reconnected'){ roomCode = message.room || roomCode; try { localStorage.setItem(hostRoomStorageKey, roomCode); } catch (e) { /* ignore */ } continuous = true; updateJoinPanel(); botIds.clear(); for (let i=1;i<=starts.length;i++) if (!message.humanIds.includes(i)) botIds.add(i); reset(); }
          if (message.type==='players'){ message.players.forEach(p=>{ humanNames[Number(p.id.slice(1))] = p.name; }); if (continuous && players) { const humanIds = message.players.map(p=>Number(p.id.slice(1))); for (let i=1;i<=starts.length;i++) { const slot = players[i-1]; if (!slot) continue; if (humanIds.includes(i) && botIds.has(i)) { botIds.delete(i); slot.bot = false; respawnPlayer(slot); } } } updateQueuePanel(message.queue || []); }
          if (message.type==='remote-input'){ if (Number.isFinite(message.input.x) && Number.isFinite(message.input.y)) remoteInputs[message.id.slice(1)] = {x: message.input.x, y: message.input.y, t: performance.now()}; }
          if (message.type==='freeze-pick'){ const targetId = Number(String(message.targetKey||'').slice(1)) - 1; const target = players[targetId]; if (target) target.frozenUntil = performance.now() + 2000; }
          if (message.type==='restart'){ round++; reset(); }
        });
      }
      connectNetwork();

            // fullscreen controls
            // Fullscreen now targets the whole shell (board + side panel) instead of just the
            // canvas, so the QR join panel, live stats and high-score leaderboard in the aside
            // stay visible instead of being hidden behind the fullscreened canvas.
            const fsBtnEl = document.getElementById('fullscreenBtn'); const fsExitEl = document.getElementById('fullscreenExit');
            const fsRootEl = document.getElementById('arenaRoot') || document.getElementById('game');
            if (fsBtnEl) fsBtnEl.addEventListener('click', (e)=>{ e.currentTarget.blur(); if (fsRootEl.requestFullscreen) fsRootEl.requestFullscreen(); else if (fsRootEl.webkitRequestFullscreen) fsRootEl.webkitRequestFullscreen(); });
            if (fsExitEl) fsExitEl.addEventListener('click', (e)=>{ e.currentTarget.blur(); if (document.exitFullscreen) document.exitFullscreen(); else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); });
            document.addEventListener('fullscreenchange', ()=>{ if (document.fullscreenElement) fsExitEl.style.display = 'block'; else fsExitEl.style.display = 'none'; });

            // the whole board is scaled to fit the fixed canvas size (see viewScale above)
            canvas.width = viewW; canvas.height = viewH;
            updateJoinPanel();
            reset(); requestAnimationFrame(frame);
    })();
