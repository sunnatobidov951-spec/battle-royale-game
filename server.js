const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  maxPayload: 64 * 1024
});

app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = {
  PORT: process.env.PORT || 3000,

  WORLD_SIZE: 500,

  MAX_PLAYERS: 50,
  MAX_SPECTATORS: 20,

  TICK_RATE: 30,
  BROADCAST_RATE: 15,

  MOVE_SPEED: 8,
  SPRINT_SPEED: 11,

  PLAYER_HEIGHT: 1.7,
  PLAYER_EYE_HEIGHT: 1.6,
  PLAYER_RADIUS: 0.5,

  MAX_HEALTH: 100,

  MIN_PLAYERS_TO_START: 2,

  MAX_MESSAGE_SIZE: 1024,

  MAX_MESSAGES_PER_SECOND: 40,

  ROTATE_RATE_LIMIT: 30,

  PING_RATE_LIMIT: 10,

  WEAPONS: {
    pistol: {
      name: 'Пистолет',
      damage: 18,
      headshot: 2,
      range: 70,
      fireRate: 220,
      magazine: 12,
      reserve: 60,
      reload: 1200,
      spread: 0.035
    },

    rifle: {
      name: 'Автомат',
      damage: 25,
      headshot: 2,
      range: 180,
      fireRate: 100,
      magazine: 30,
      reserve: 120,
      reload: 1800,
      spread: 0.025
    },

    sniper: {
      name: 'Снайперка',
      damage: 80,
      headshot: 3,
      range: 350,
      fireRate: 900,
      magazine: 5,
      reserve: 25,
      reload: 2200,
      spread: 0.008
    },

    shotgun: {
      name: 'Дробовик',
      damage: 12,
      headshot: 1.5,
      range: 45,
      fireRate: 850,
      magazine: 6,
      reserve: 30,
      reload: 2000,
      spread: 0.12,
      pellets: 8
    }
  },

  ZONE: {
    startRadius: 245,

    waitBeforeShrink: 30000,

    shrinkSpeed: 7,

    minRadius: 5,

    damagePerSecond: 8,

    phases: [
      180,
      125,
      85,
      55,
      35,
      20,
      10,
      5
    ]
  },

  LOOT_COUNT: 70,

  LOOT_DISTANCE: 4,

  MIN_SPAWN_DISTANCE: 15,

  MAP_MARGIN: 3,

  MATCH_END_DELAY: 5000
};


/* =========================================================
   GAME STATE
========================================================= */

const game = {
  status: 'waiting',

  matchId: null,

  players: {},

  loot: [],

  winner: null,

  startedAt: 0,

  endTimer: null,

  zone: {
    x: 0,
    z: 0,

    radius: CONFIG.ZONE.startRadius,

    startX: 0,
    startZ: 0,

    startRadius: CONFIG.ZONE.startRadius,

    targetX: 0,
    targetZ: 0,

    targetRadius: CONFIG.ZONE.startRadius,

    phase: 0,

    shrinking: false,

    progress: 1,

    nextShrink: 0
  },

  lastBroadcast: 0
};


/* =========================================================
   UTILS
========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance2D(a, b) {
  return Math.hypot(
    a.x - b.x,
    a.z - b.z
  );
}

function distance3D(a, b) {
  return Math.hypot(
    a.x - b.x,
    a.y - b.y,
    a.z - b.z
  );
}

function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

function randomPosition() {
  const half =
    CONFIG.WORLD_SIZE / 2 -
    CONFIG.MAP_MARGIN;

  return {
    x: randomRange(-half, half),
    z: randomRange(-half, half)
  };
}

function insideWorld(pos) {
  const half = CONFIG.WORLD_SIZE / 2;

  return (
    pos.x >= -half &&
    pos.x <= half &&
    pos.z >= -half &&
    pos.z <= half
  );
}

function insideZone(pos) {
  return distance2D(pos, game.zone) <= game.zone.radius;
}

function safeSend(ws, data) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    try {
      ws.send(data);
    } catch {}
  }
}

function sendJSON(ws, data) {
  safeSend(ws, JSON.stringify(data));
}


/* =========================================================
   PLAYER CREATION
========================================================= */

function createPlayer(ws, role) {
  const id = uuidv4();

  return {
    id,

    ws,

    role,

    state:
      role === 'player'
        ? 'waiting'
        : 'spectator',

    position: {
      x: 0,
      z: 0
    },

    rotation: {
      yaw: 0,
      pitch: 0
    },

    health: 100,

    kills: 0,

    weapon: 'pistol',

    ammo: 12,

    reserveAmmo: 60,

    reloading: false,

    reloadEnd: 0,

    lastShot: 0,

    lastRotate: 0,

    lastPing: 0,

    lastSeen: Date.now(),

    messageCount: 0,

    messageReset: Date.now(),

    input: {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false
    },

    stats: {
      damage: 0,
      shots: 0,
      hits: 0
    }
  };
}


/* =========================================================
   SPAWN
========================================================= */

function findSpawn(existing) {
  const maxAttempts = 500;

  for (let i = 0; i < maxAttempts; i++) {
    const pos = randomPosition();

    if (!insideZone(pos)) {
      continue;
    }

    let valid = true;

    for (const other of existing) {
      if (
        distance2D(pos, other) <
        CONFIG.MIN_SPAWN_DISTANCE
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      return pos;
    }
  }

  return {
    x: game.zone.x,
    z: game.zone.z
  };
}

function generateSpawns(players) {
  const positions = [];

  for (let i = 0; i < players.length; i++) {
    positions.push(findSpawn(positions));
  }

  return positions;
}


/* =========================================================
   ZONE
========================================================= */

function initZone() {
  const z = game.zone;

  z.x = 0;
  z.z = 0;

  z.radius = CONFIG.ZONE.startRadius;

  z.startX = 0;
  z.startZ = 0;

  z.startRadius =
    CONFIG.ZONE.startRadius;

  z.targetX = 0;
  z.targetZ = 0;

  z.targetRadius =
    CONFIG.ZONE.startRadius;

  z.phase = 0;

  z.shrinking = false;

  z.progress = 1;

  z.nextShrink =
    Date.now() +
    CONFIG.ZONE.waitBeforeShrink;
}

function beginZoneShrink() {
  const z = game.zone;

  if (
    z.phase >=
    CONFIG.ZONE.phases.length
  ) {
    return;
  }

  const targetRadius =
    CONFIG.ZONE.phases[z.phase];

  if (targetRadius >= z.radius) {
    z.phase++;
    return;
  }

  const maxCenterMove =
    Math.max(
      0,
      z.radius - targetRadius
    );

  const angle =
    Math.random() * Math.PI * 2;

  const moveDistance =
    Math.random() *
    maxCenterMove *
    0.65;

  const newX =
    z.x +
    Math.cos(angle) *
    moveDistance;

  const newZ =
    z.z +
    Math.sin(angle) *
    moveDistance;

  z.startX = z.x;
  z.startZ = z.z;

  z.startRadius = z.radius;

  z.targetX = clamp(
    newX,
    -CONFIG.WORLD_SIZE / 2 + targetRadius,
    CONFIG.WORLD_SIZE / 2 - targetRadius
  );

  z.targetZ = clamp(
    newZ,
    -CONFIG.WORLD_SIZE / 2 + targetRadius,
    CONFIG.WORLD_SIZE / 2 - targetRadius
  );

  z.targetRadius = targetRadius;

  z.progress = 0;

  z.shrinking = true;

  z.phase++;
}

function updateZone(dt) {
  if (game.status !== 'playing') {
    return;
  }

  const z = game.zone;

  if (
    !z.shrinking &&
    Date.now() >= z.nextShrink
  ) {
    beginZoneShrink();
  }

  if (z.shrinking) {
    const difference =
      z.startRadius -
      z.targetRadius;

    const speedProgress =
      difference > 0
        ? (CONFIG.ZONE.shrinkSpeed * dt) /
          difference
        : 1;

    z.progress = Math.min(
      1,
      z.progress + speedProgress
    );

    const t = z.progress;

    z.x =
      z.startX +
      (z.targetX - z.startX) * t;

    z.z =
      z.startZ +
      (z.targetZ - z.startZ) * t;

    z.radius =
      z.startRadius +
      (z.targetRadius - z.startRadius) * t;

    if (z.progress >= 1) {
      z.x = z.targetX;
      z.z = z.targetZ;

      z.radius =
        z.targetRadius;

      z.shrinking = false;

      z.nextShrink =
        Date.now() +
        CONFIG.ZONE.waitBeforeShrink;
    }
  }

  applyZoneDamage(dt);
}

function applyZoneDamage(dt) {
  for (const id in game.players) {
    const p = game.players[id];

    if (
      p.role !== 'player' ||
      p.state !== 'alive'
    ) {
      continue;
    }

    if (!insideZone(p.position)) {
      p.health -=
        CONFIG.ZONE.damagePerSecond *
        dt;

      if (p.health <= 0) {
        killPlayer(
          p.id,
          'zone',
          null
        );
      }
    }
  }
}


/* =========================================================
   MOVEMENT
========================================================= */

function applyMovement(player, dt) {
  if (
    player.state !== 'alive' ||
    player.role !== 'player'
  ) {
    return;
  }

  const input = player.input;

  const yaw =
    player.rotation.yaw || 0;

  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);

  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  let x = 0;
  let z = 0;

  if (input.forward) {
    x += forwardX;
    z += forwardZ;
  }

  if (input.backward) {
    x -= forwardX;
    z -= forwardZ;
  }

  if (input.left) {
    x -= rightX;
    z -= rightZ;
  }

  if (input.right) {
    x += rightX;
    z += rightZ;
  }

  const len = Math.hypot(x, z);

  if (len < 0.001) {
    return;
  }

  x /= len;
  z /= len;

  const speed =
    input.sprint
      ? CONFIG.SPRINT_SPEED
      : CONFIG.MOVE_SPEED;

  const move =
    speed * dt;

  player.position.x += x * move;
  player.position.z += z * move;

  const half =
    CONFIG.WORLD_SIZE / 2 -
    CONFIG.PLAYER_RADIUS;

  player.position.x =
    clamp(
      player.position.x,
      -half,
      half
    );

  player.position.z =
    clamp(
      player.position.z,
      -half,
      half
    );
}


/* =========================================================
   ROTATION
========================================================= */

function rotatePlayer(
  player,
  yaw,
  pitch
) {
  if (
    !Number.isFinite(yaw) ||
    !Number.isFinite(pitch)
  ) {
    return;
  }

  const now = Date.now();

  if (
    now - player.lastRotate <
    1000 / CONFIG.ROTATE_RATE_LIMIT
  ) {
    return;
  }

  player.lastRotate = now;

  yaw =
    ((yaw % (Math.PI * 2)) +
      Math.PI * 2) %
    (Math.PI * 2);

  pitch = clamp(
    pitch,
    -Math.PI / 2 + 0.01,
    Math.PI / 2 - 0.01
  );

  player.rotation.yaw = yaw;
  player.rotation.pitch = pitch;
}


/* =========================================================
   RELOAD
========================================================= */

function startReload(player) {
  if (
    player.state !== 'alive' ||
    player.reloading
  ) {
    return;
  }

  const weapon =
    CONFIG.WEAPONS[player.weapon];

  if (!weapon) {
    return;
  }

  if (
    player.ammo >= weapon.magazine
  ) {
    return;
  }

  if (
    player.reserveAmmo <= 0
  ) {
    return;
  }

  player.reloading = true;

  player.reloadEnd =
    Date.now() + weapon.reload;
}

function updateReload(player) {
  if (!player.reloading) {
    return;
  }

  if (
    Date.now() <
    player.reloadEnd
  ) {
    return;
  }

  const weapon =
    CONFIG.WEAPONS[player.weapon];

  if (!weapon) {
    player.reloading = false;
    return;
  }

  const needed =
    weapon.magazine -
    player.ammo;

  const amount =
    Math.min(
      needed,
      player.reserveAmmo
    );

  player.ammo += amount;
  player.reserveAmmo -= amount;

  player.reloading = false;
  player.reloadEnd = 0;
}


/* =========================================================
   RAYCAST
========================================================= */

function getShotDirection(
  player,
  weapon
) {
  const yaw =
    player.rotation.yaw;

  const pitch =
    player.rotation.pitch;

  const spread =
    weapon.spread || 0;

  const finalYaw =
    yaw +
    randomRange(-spread, spread);

  const finalPitch =
    pitch +
    randomRange(-spread, spread);

  return {
    x:
      -Math.sin(finalYaw) *
      Math.cos(finalPitch),

    y:
      Math.sin(finalPitch),

    z:
      -Math.cos(finalYaw) *
      Math.cos(finalPitch)
  };
}

function raySphere(
  origin,
  direction,
  center,
  radius,
  maxDistance
) {
  const ox =
    origin.x - center.x;

  const oy =
    origin.y - center.y;

  const oz =
    origin.z - center.z;

  const b =
    ox * direction.x +
    oy * direction.y +
    oz * direction.z;

  const c =
    ox * ox +
    oy * oy +
    oz * oz -
    radius * radius;

  const discriminant =
    b * b - c;

  if (discriminant < 0) {
    return null;
  }

  const sqrt =
    Math.sqrt(discriminant);

  let t =
    -b - sqrt;

  if (t < 0) {
    t = -b + sqrt;
  }

  if (
    t < 0 ||
    t > maxDistance
  ) {
    return null;
  }

  return t;
}


/* =========================================================
   SHOOT
========================================================= */

function shoot(player) {
  if (
    game.status !== 'playing' ||
    player.state !== 'alive' ||
    player.role !== 'player'
  ) {
    return;
  }

  updateReload(player);

  if (player.reloading) {
    return;
  }

  const weapon =
    CONFIG.WEAPONS[player.weapon];

  if (!weapon) {
    return;
  }

  const now = Date.now();

  if (
    now - player.lastShot <
    weapon.fireRate
  ) {
    return;
  }

  if (player.ammo <= 0) {
    startReload(player);
    return;
  }

  player.lastShot = now;

  player.ammo--;

  player.stats.shots++;

  const origin = {
    x: player.position.x,
    y: CONFIG.PLAYER_EYE_HEIGHT,
    z: player.position.z
  };

  const pellets =
    weapon.pellets || 1;

  let bestTarget = null;
  let bestDistance = Infinity;
  let bestHeadshot = false;

  for (let pellet = 0; pellet < pellets; pellet++) {
    const direction =
      getShotDirection(
        player,
        weapon
      );

    for (const id in game.players) {
      if (id === player.id) {
        continue;
      }

      const target =
        game.players[id];

      if (
        target.role !== 'player' ||
        target.state !== 'alive'
      ) {
        continue;
      }

      const body = {
        x: target.position.x,
        y: CONFIG.PLAYER_HEIGHT * 0.5,
        z: target.position.z
      };

      const head = {
        x: target.position.x,
        y: CONFIG.PLAYER_HEIGHT - 0.2,
        z: target.position.z
      };

      const bodyHit =
        raySphere(
          origin,
          direction,
          body,
          0.65,
          weapon.range
        );

      const headHit =
        raySphere(
          origin,
          direction,
          head,
          0.32,
          weapon.range
        );

      if (
        headHit !== null &&
        headHit < bestDistance
      ) {
        bestDistance = headHit;
        bestTarget = target;
        bestHeadshot = true;
      }

      if (
        bodyHit !== null &&
        bodyHit < bestDistance
      ) {
        bestDistance = bodyHit;
        bestTarget = target;
        bestHeadshot = false;
      }
    }

    if (bestTarget) {
      let damage =
        weapon.damage;

      if (bestHeadshot) {
        damage *=
          weapon.headshot;
      }

      damage =
        Math.round(damage);

      bestTarget.health =
        clamp(
          bestTarget.health -
            damage,
          0,
          CONFIG.MAX_HEALTH
        );

      player.stats.damage +=
        damage;

      player.stats.hits++;

      broadcast({
        type: 'hit',
        shooterId: player.id,
        targetId: bestTarget.id,
        damage,
        headshot: bestHeadshot,
        weapon: player.weapon
      });

      if (
        bestTarget.health <= 0
      ) {
        killPlayer(
          bestTarget.id,
          'bullet',
          player.id
        );
      }

      if (pellets === 1) {
        break;
      }
    }
  }
}


/* =========================================================
   KILL
========================================================= */

function killPlayer(
  playerId,
  cause,
  killerId
) {
  const player =
    game.players[playerId];

  if (
    !player ||
    player.state !== 'alive'
  ) {
    return;
  }

  player.health = 0;

  player.state = 'dead';

  player.input = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false
  };

  if (killerId) {
    const killer =
      game.players[killerId];

    if (killer) {
      killer.kills++;
    }
  }

  broadcast({
    type: 'death',
    playerId,
    killerId: killerId || null,
    cause
  });

  checkMatchEnd();
}


/* =========================================================
   LOOT
========================================================= */

function generateLoot() {
  const items = [];

  const weapons =
    Object.keys(CONFIG.WEAPONS);

  let attempts = 0;

  while (
    items.length <
      CONFIG.LOOT_COUNT &&
    attempts < 3000
  ) {
    attempts++;

    const pos =
      randomPosition();

    if (!insideZone(pos)) {
      continue;
    }

    let tooClose = false;

    for (const item of items) {
      if (
        distance2D(
          pos,
          item.position
        ) < CONFIG.LOOT_DISTANCE
      ) {
        tooClose = true;
        break;
      }
    }

    if (tooClose) {
      continue;
    }

    const weapon =
      weapons[
        Math.floor(
          Math.random() *
          weapons.length
        )
      ];

    items.push({
      id: uuidv4(),

      position: pos,

      weapon,

      ammo:
        CONFIG.WEAPONS[weapon].magazine,

      reserve:
        CONFIG.WEAPONS[weapon].reserve,

      picked: false
    });
  }

  return items;
}

function pickupLoot(
  player,
  lootId
) {
  if (
    player.state !== 'alive'
  ) {
    return;
  }

  const item =
    game.loot.find(
      x =>
        x.id === lootId &&
        !x.picked
    );

  if (!item) {
    return;
  }

  if (
    distance2D(
      player.position,
      item.position
    ) > 4
  ) {
    return;
  }

  item.picked = true;

  player.weapon =
    item.weapon;

  const weapon =
    CONFIG.WEAPONS[
      item.weapon
    ];

  player.ammo =
    Math.min(
      item.ammo,
      weapon.magazine
    );

  player.reserveAmmo =
    item.reserve;

  player.reloading = false;

  broadcast({
    type: 'loot-pickup',
    lootId: item.id,
    playerId: player.id
  });
}


/* =========================================================
   MATCH
========================================================= */

function startMatch() {
  if (
    game.status !== 'waiting'
  ) {
    return;
  }

  const players =
    Object.values(
      game.players
    ).filter(
      p => p.role === 'player'
    );

  if (
    players.length <
    CONFIG.MIN_PLAYERS_TO_START
  ) {
    return;
  }

  game.status = 'playing';

  game.matchId = uuidv4();

  game.startedAt =
    Date.now();

  game.winner = null;

  initZone();

  game.loot =
    generateLoot();

  const positions =
    generateSpawns(players);

  players.forEach(
    (player, index) => {
      const weapon =
        CONFIG.WEAPONS.pistol;

      player.position =
        positions[index];

      player.rotation = {
        yaw: 0,
        pitch: 0
      };

      player.health = 100;

      player.state = 'alive';

      player.kills = 0;

      player.weapon =
        'pistol';

      player.ammo =
        weapon.magazine;

      player.reserveAmmo =
        weapon.reserve;

      player.reloading = false;

      player.lastShot = 0;

      player.input = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false
      };

      player.stats = {
        damage: 0,
        shots: 0,
        hits: 0
      };
    }
  );

  console.log(
    `🎮 MATCH START ${game.matchId} | players=${players.length}`
  );

  broadcast({
    type: 'match-start',
    matchId: game.matchId
  });

  broadcastState();
}

function checkMatchEnd() {
  if (
    game.status !== 'playing'
  ) {
    return;
  }

  const alive =
    Object.values(
      game.players
    ).filter(
      p =>
        p.role === 'player' &&
        p.state === 'alive'
    );

  if (alive.length === 0) {
    finishMatch(null);
    return;
  }

  if (alive.length === 1) {
    finishMatch(alive[0].id);
  }
}

function finishMatch(winnerId) {
  if (
    game.status !== 'playing'
  ) {
    return;
  }

  game.status = 'ending';

  game.winner =
    winnerId || null;

  broadcast({
    type: winnerId
      ? 'winner'
      : 'draw',

    playerId:
      winnerId || null,

    nextMatchIn:
      CONFIG.MATCH_END_DELAY
  });

  if (game.endTimer) {
    clearTimeout(
      game.endTimer
    );
  }

  game.endTimer =
    setTimeout(
      resetMatch,
      CONFIG.MATCH_END_DELAY
    );
}

function resetMatch() {
  game.status = 'waiting';

  game.matchId = null;

  game.winner = null;

  game.loot = [];

  for (const id in game.players) {
    const p =
      game.players[id];

    if (
      p.role === 'spectator'
    ) {
      p.role = 'player';
    }

    p.state = 'waiting';
  }

  game.endTimer = null;

  broadcastState();

  startMatch();
}


/* =========================================================
   BROADCAST
========================================================= */

function buildState() {
  return {
    type: 'state',

    status: game.status,

    matchId: game.matchId,

    players:
      Object.values(
        game.players
      ).map(p => ({
        id: p.id,

        role: p.role,

        position: p.position,

        rotation: p.rotation,

        health: p.health,

        alive:
          p.state === 'alive',

        kills: p.kills,

        weapon: p.weapon,

        ammo: p.ammo,

        reserveAmmo:
          p.reserveAmmo,

        reloading:
          p.reloading
      })),

    zone: {
      x: game.zone.x,

      z: game.zone.z,

      radius:
        game.zone.radius,

      targetRadius:
        game.zone.targetRadius,

      phase:
        game.zone.phase,

      shrinking:
        game.zone.shrinking,

      progress:
        game.zone.progress,

      nextShrink:
        game.zone.nextShrink
    },

    loot:
      game.loot
        .filter(
          item => !item.picked
        )
        .map(item => ({
          id: item.id,

          position:
            item.position,

          weapon:
            item.weapon
        })),

    winner:
      game.winner
  };
}

function broadcast(data) {
  const msg =
    JSON.stringify(data);

  wss.clients.forEach(
    ws => {
      safeSend(ws, msg);
    }
  );
}

function broadcastState() {
  if (
    Object.keys(
      game.players
    ).length === 0
  ) {
    return;
  }

  broadcast(
    buildState()
  );
}


/* =========================================================
   CONNECTION LIMITS
========================================================= */

function countPlayers() {
  return Object.values(
    game.players
  ).filter(
    p => p.role === 'player'
  ).length;
}

function countSpectators() {
  return Object.values(
    game.players
  ).filter(
    p => p.role === 'spectator'
  ).length;
}


/* =========================================================
   WEBSOCKET
========================================================= */

wss.on(
  'connection',
  ws => {
    const players =
      countPlayers();

    const spectators =
      countSpectators();

    let role = 'player';

    if (
      game.status === 'playing' ||
      game.status === 'ending'
    ) {
      role = 'spectator';
    }

    if (
      role === 'player' &&
      players >= CONFIG.MAX_PLAYERS
    ) {
      if (
        spectators <
        CONFIG.MAX_SPECTATORS
      ) {
        role = 'spectator';
      } else {
        sendJSON(ws, {
          type: 'error',
          message:
            'Сервер переполнен'
        });

        ws.close();

        return;
      }
    }

    if (
      role === 'spectator' &&
      spectators >=
        CONFIG.MAX_SPECTATORS
    ) {
      sendJSON(ws, {
        type: 'error',
        message:
          'Лимит зрителей достигнут'
      });

      ws.close();

      return;
    }

    const player =
      createPlayer(
        ws,
        role
      );

    game.players[
      player.id
    ] = player;

    ws.isAlive = true;

    ws.on(
      'pong',
      () => {
        ws.isAlive = true;

        player.lastSeen =
          Date.now();
      }
    );

    sendJSON(ws, {
      type: 'init',

      id: player.id,

      role: player.role,

      worldSize:
        CONFIG.WORLD_SIZE,

      config: {
        moveSpeed:
          CONFIG.MOVE_SPEED,

        sprintSpeed:
          CONFIG.SPRINT_SPEED,

        playerHeight:
          CONFIG.PLAYER_HEIGHT,

        eyeHeight:
          CONFIG.PLAYER_EYE_HEIGHT,

        weapons:
          CONFIG.WEAPONS
      },

      status:
        game.status
    });

    console.log(
      `✅ CONNECT ${player.id} | ${player.role}`
    );

    ws.on(
      'message',
      raw => {
        if (
          raw.length >
          CONFIG.MAX_MESSAGE_SIZE
        ) {
          return;
        }

        let data;

        try {
          data =
            JSON.parse(
              raw.toString()
            );
        } catch {
          return;
        }

        if (
          !data ||
          typeof data !== 'object'
        ) {
          return;
        }

        const now =
          Date.now();

        if (
          now -
            player.messageReset >
          1000
        ) {
          player.messageReset =
            now;

          player.messageCount =
            0;
        }

        player.messageCount++;

        if (
          player.messageCount >
          CONFIG.MAX_MESSAGES_PER_SECOND
        ) {
          return;
        }

        player.lastSeen =
          now;

        if (
          player.role ===
          'spectator'
        ) {
          return;
        }

        if (
          player.state ===
          'dead'
        ) {
          return;
        }

        switch (
          data.type
        ) {
          case 'move-input': {
            const input =
              data.input || {};

            player.input = {
              forward:
                input.forward === true,

              backward:
                input.backward === true,

              left:
                input.left === true,

              right:
                input.right === true,

              sprint:
                input.sprint === true
            };

            break;
          }

          case 'rotate': {
            rotatePlayer(
              player,
              Number(data.yaw),
              Number(data.pitch)
            );

            break;
          }

          case 'shoot': {
            shoot(player);

            break;
          }

          case 'reload': {
            startReload(player);

            break;
          }

          case 'pickup': {
            if (
              typeof data.lootId ===
                'string' &&
              data.lootId.length <
                100
            ) {
              pickupLoot(
                player,
                data.lootId
              );
            }

            break;
          }

          case 'ping': {
            if (
              now -
                player.lastPing <
              1000 /
                CONFIG.PING_RATE_LIMIT
            ) {
              return;
            }

            player.lastPing =
              now;

            sendJSON(ws, {
              type: 'pong'
            });

            break;
          }
        }
      }
    );

    ws.on(
      'close',
      () => {
        delete game.players[
          player.id
        ];

        console.log(
          `❌ DISCONNECT ${player.id}`
        );

        if (
          game.status ===
          'playing'
        ) {
          checkMatchEnd();
        }

        if (
          game.status ===
          'waiting'
        ) {
          startMatch();
        }

        broadcastState();
      }
    );

    ws.on(
      'error',
      () => {
        try {
          ws.close();
        } catch {}
      }
    );

    broadcastState();

    startMatch();
  }
);


/* =========================================================
   HEARTBEAT
========================================================= */

setInterval(
  () => {
    wss.clients.forEach(
      ws => {
        if (
          ws.isAlive === false
        ) {
          try {
            ws.terminate();
          } catch {}

          return;
        }

        ws.isAlive = false;

        try {
          ws.ping();
        } catch {}
      }
    );
  },
  30000
);


/* =========================================================
   GAME LOOP
========================================================= */

const FIXED_DT =
  1 / CONFIG.TICK_RATE;

let lastTime =
  performance.now();

let accumulator = 0;

function gameLoop() {
  const now =
    performance.now();

  let frame =
    (now - lastTime) /
    1000;

  lastTime = now;

  frame =
    Math.min(frame, 0.1);

  accumulator += frame;

  while (
    accumulator >=
    FIXED_DT
  ) {
    if (
      game.status ===
      'playing'
    ) {
      updateZone(
        FIXED_DT
      );

      for (
        const id in game.players
      ) {
        const p =
          game.players[id];

        if (
          p.role === 'player' &&
          p.state === 'alive'
        ) {
          applyMovement(
            p,
            FIXED_DT
          );

          updateReload(p);
        }
      }

      checkMatchEnd();
    }

    accumulator -=
      FIXED_DT;
  }

  const nowMs =
    Date.now();

  if (
    nowMs -
      game.lastBroadcast >=
    1000 /
      CONFIG.BROADCAST_RATE
  ) {
    broadcastState();

    game.lastBroadcast =
      nowMs;
  }

  setImmediate(
    gameLoop
  );
}

gameLoop();


/* =========================================================
   SERVER
========================================================= */

server.listen(
  CONFIG.PORT,
  '0.0.0.0',
  () => {
    console.log('');
    console.log(
      '================================'
    );
    console.log(
      '🔥 BATTLE ROYALE SERVER ONLINE'
    );
    console.log(
      '================================'
    );
    console.log(
      `🌍 World: ${CONFIG.WORLD_SIZE}x${CONFIG.WORLD_SIZE}`
    );
    console.log(
      `👥 Players: ${CONFIG.MAX_PLAYERS}`
    );
    console.log(
      `👁 Spectators: ${CONFIG.MAX_SPECTATORS}`
    );
    console.log(
      `⚙ Tick: ${CONFIG.TICK_RATE} Hz`
    );
    console.log(
      `📡 Broadcast: ${CONFIG.BROADCAST_RATE} Hz`
    );
    console.log(
      `🔫 Weapons: ${Object.keys(CONFIG.WEAPONS).join(', ')}`
    );
    console.log(
      '================================'
    );
  }
);
