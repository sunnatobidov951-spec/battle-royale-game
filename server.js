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

const PORT = process.env.PORT || 3000;
const WORLD_SIZE = 500;
const MAX_PLAYERS = 50;
const MAX_SPECTATORS = 20;
const TICK_RATE = 30;
const BROADCAST_RATE = 15;

const MOVE_SPEED = 8;
const SPRINT_SPEED = 11;

const PLAYER_HEIGHT = 1.7;
const PLAYER_EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.5;

const MAX_HEALTH = 100;
const MIN_PLAYERS_TO_START = 2;

const WEAPONS = {
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
};

const ZONE = {
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
};

const game = {
  status: 'waiting',
  matchId: null,
  players: {},
  winner: null,
  startedAt: 0,
  endTimer: null,
  loot: [],
  lastBroadcast: 0,

  zone: {
    x: 0,
    z: 0,
    radius: ZONE.startRadius,
    startX: 0,
    startZ: 0,
    startRadius: ZONE.startRadius,
    targetX: 0,
    targetZ: 0,
    targetRadius: ZONE.startRadius,
    phase: 0,
    shrinking: false,
    progress: 1,
    nextShrink: 0
  }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance2D(a, b) {
  return Math.hypot(
    a.x - b.x,
    a.z - b.z
  );
}

function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

function randomPosition() {
  const half =
    WORLD_SIZE / 2 - 5;

  return {
    x: randomRange(-half, half),
    z: randomRange(-half, half)
  };
}

function insideZone(pos) {
  return distance2D(pos, game.zone) <= game.zone.radius;
}

function sendJSON(ws, data) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }
}

function broadcast(data) {
  const message = JSON.stringify(data);

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
      } catch {}
    }
  });
}

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

    health: MAX_HEALTH,
    kills: 0,

    weapon: 'pistol',
    ammo: WEAPONS.pistol.magazine,
    reserveAmmo: WEAPONS.pistol.reserve,

    reloading: false,
    reloadEnd: 0,
    lastShot: 0,

    input: {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false
    }
  };
}

function findSpawn(existing) {
  for (let i = 0; i < 500; i++) {
    const position = randomPosition();

    if (!insideZone(position)) {
      continue;
    }

    let valid = true;

    for (const other of existing) {
      if (
        distance2D(position, other) < 15
      ) {
        valid = false;
        break;
      }
    }

    if (valid) {
      return position;
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

function initZone() {
  game.zone = {
    x: 0,
    z: 0,

    radius: ZONE.startRadius,

    startX: 0,
    startZ: 0,
    startRadius: ZONE.startRadius,

    targetX: 0,
    targetZ: 0,
    targetRadius: ZONE.startRadius,

    phase: 0,
    shrinking: false,
    progress: 1,

    nextShrink:
      Date.now() +
      ZONE.waitBeforeShrink
  };
}

function beginZoneShrink() {
  const z = game.zone;

  if (z.phase >= ZONE.phases.length) {
    return;
  }

  const targetRadius =
    ZONE.phases[z.phase];

  if (targetRadius >= z.radius) {
    z.phase++;
    return;
  }

  const angle =
    Math.random() * Math.PI * 2;

  const maxMove =
    Math.max(
      0,
      z.radius - targetRadius
    );

  const moveDistance =
    Math.random() *
    maxMove *
    0.65;

  z.startX = z.x;
  z.startZ = z.z;
  z.startRadius = z.radius;

  z.targetX = clamp(
    z.x +
      Math.cos(angle) *
      moveDistance,
    -WORLD_SIZE / 2 + targetRadius,
    WORLD_SIZE / 2 - targetRadius
  );

  z.targetZ = clamp(
    z.z +
      Math.sin(angle) *
      moveDistance,
    -WORLD_SIZE / 2 + targetRadius,
    WORLD_SIZE / 2 - targetRadius
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

    const progress =
      difference > 0
        ? ZONE.shrinkSpeed * dt / difference
        : 1;

    z.progress =
      Math.min(
        1,
        z.progress + progress
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
      z.radius = z.targetRadius;
      z.shrinking = false;

      z.nextShrink =
        Date.now() +
        ZONE.waitBeforeShrink;
    }
  }

  applyZoneDamage(dt);
}

function applyZoneDamage(dt) {
  for (const id in game.players) {
    const player = game.players[id];

    if (
      player.role !== 'player' ||
      player.state !== 'alive'
    ) {
      continue;
    }

    if (!insideZone(player.position)) {
      player.health -=
        ZONE.damagePerSecond * dt;

      if (player.health <= 0) {
        killPlayer(
          player.id,
          'zone',
          null
        );
      }
    }
  }
}

function applyMovement(player, dt) {
  if (
    player.role !== 'player' ||
    player.state !== 'alive'
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

  const length =
    Math.hypot(x, z);

  if (length < 0.001) {
    return;
  }

  x /= length;
  z /= length;

  const speed =
    input.sprint
      ? SPRINT_SPEED
      : MOVE_SPEED;

  player.position.x +=
    x * speed * dt;

  player.position.z +=
    z * speed * dt;

  const half =
    WORLD_SIZE / 2 -
    PLAYER_RADIUS;

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

  player.rotation.yaw = yaw;
  player.rotation.pitch =
    clamp(
      pitch,
      -Math.PI / 2 + 0.01,
      Math.PI / 2 - 0.01
    );
}

function startReload(player) {
  if (
    player.state !== 'alive' ||
    player.reloading
  ) {
    return;
  }

  const weapon =
    WEAPONS[player.weapon];

  if (!weapon) {
    return;
  }

  if (
    player.ammo >= weapon.magazine ||
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
    WEAPONS[player.weapon];

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

  const root =
    Math.sqrt(discriminant);

  let t =
    -b - root;

  if (t < 0) {
    t = -b + root;
  }

  if (
    t < 0 ||
    t > maxDistance
  ) {
    return null;
  }

  return t;
}

function getShotDirection(
  player,
  weapon
) {
  const spread =
    weapon.spread || 0;

  const yaw =
    player.rotation.yaw +
    randomRange(-spread, spread);

  const pitch =
    player.rotation.pitch +
    randomRange(-spread, spread);

  return {
    x:
      -Math.sin(yaw) *
      Math.cos(pitch),

    y:
      Math.sin(pitch),

    z:
      -Math.cos(yaw) *
      Math.cos(pitch)
  };
}

function shoot(player) {
  if (
    game.status !== 'playing' ||
    player.role !== 'player' ||
    player.state !== 'alive'
  ) {
    return;
  }

  updateReload(player);

  if (player.reloading) {
    return;
  }

  const weapon =
    WEAPONS[player.weapon];

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

  const origin = {
    x: player.position.x,
    y: PLAYER_EYE_HEIGHT,
    z: player.position.z
  };

  const pellets =
    weapon.pellets || 1;

  for (
    let pellet = 0;
    pellet < pellets;
    pellet++
  ) {
    const direction =
      getShotDirection(
        player,
        weapon
      );

    let bestTarget = null;
    let bestDistance =
      Infinity;

    let headshot = false;

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
        y: PLAYER_HEIGHT * 0.5,
        z: target.position.z
      };

      const head = {
        x: target.position.x,
        y: PLAYER_HEIGHT - 0.2,
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
        headshot = true;
      }

      if (
        bodyHit !== null &&
        bodyHit < bestDistance
      ) {
        bestDistance = bodyHit;
        bestTarget = target;
        headshot = false;
      }
    }

    if (bestTarget) {
      let damage =
        weapon.damage;

      if (headshot) {
        damage *= weapon.headshot;
      }

      damage = Math.round(damage);

      bestTarget.health =
        clamp(
          bestTarget.health - damage,
          0,
          MAX_HEALTH
        );

      broadcast({
        type: 'hit',
        shooterId: player.id,
        targetId: bestTarget.id,
        damage,
        headshot,
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
    }
  }
}

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

function generateLoot() {
  const loot = [];
  const weapons =
    Object.keys(WEAPONS);

  for (let i = 0; i < 70; i++) {
    const position =
      randomPosition();

    const weapon =
      weapons[
        Math.floor(
          Math.random() *
          weapons.length
        )
      ];

    loot.push({
      id: uuidv4(),
      position,
      weapon,
      picked: false
    });
  }

  return loot;
}

function pickupLoot(
  player,
  lootId
) {
  const item =
    game.loot.find(
      loot =>
        loot.id === lootId &&
        !loot.picked
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
    WEAPONS[item.weapon];

  player.ammo =
    weapon.magazine;

  player.reserveAmmo =
    weapon.reserve;

  broadcast({
    type: 'loot-pickup',
    lootId: item.id,
    playerId: player.id
  });
}

function countPlayers() {
  return Object.values(
    game.players
  ).filter(
    player =>
      player.role === 'player'
  ).length;
}

function countSpectators() {
  return Object.values(
    game.players
  ).filter(
    player =>
      player.role === 'spectator'
  ).length;
}

function startMatch() {
  if (game.status !== 'waiting') {
    return;
  }

  const players =
    Object.values(
      game.players
    ).filter(
      player =>
        player.role === 'player'
    );

  if (
    players.length <
    MIN_PLAYERS_TO_START
  ) {
    return;
  }

  game.status = 'playing';
  game.matchId = uuidv4();
  game.startedAt = Date.now();
  game.winner = null;

  initZone();

  game.loot =
    generateLoot();

  const spawns =
    generateSpawns(players);

  players.forEach(
    (player, index) => {

      player.position =
        spawns[index];

      player.rotation = {
        yaw: 0,
        pitch: 0
      };

      player.health =
        MAX_HEALTH;

      player.state = 'alive';

      player.kills = 0;

      player.weapon = 'pistol';

      player.ammo =
        WEAPONS.pistol.magazine;

      player.reserveAmmo =
        WEAPONS.pistol.reserve;

      player.reloading = false;
      player.lastShot = 0;

      player.input = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false
      };
    }
  );

  console.log(
    `MATCH START ${game.matchId} players=${players.length}`
  );

  broadcast({
    type: 'match-start',
    matchId: game.matchId
  });

  broadcastState();
}

function checkMatchEnd() {
  if (game.status !== 'playing') {
    return;
  }

  const alive =
    Object.values(
      game.players
    ).filter(
      player =>
        player.role === 'player' &&
        player.state === 'alive'
    );

  if (alive.length === 0) {
    finishMatch(null);
  } else if (alive.length === 1) {
    finishMatch(alive[0].id);
  }
}

function finishMatch(winnerId) {
  if (game.status !== 'playing') {
    return;
  }

  game.status = 'ending';
  game.winner = winnerId || null;

  broadcast({
    type: winnerId
      ? 'winner'
      : 'draw',

    playerId:
      winnerId || null,

    nextMatchIn: 5000
  });

  game.endTimer =
    setTimeout(
      resetMatch,
      5000
    );
}

function resetMatch() {
  game.status = 'waiting';
  game.matchId = null;
  game.winner = null;
  game.loot = [];

  for (const id in game.players) {
    const player =
      game.players[id];

    player.state = 'waiting';

    if (
      player.role === 'spectator'
    ) {
      player.role = 'player';
    }
  }

  game.endTimer = null;

  broadcastState();

  startMatch();
}

function buildState() {
  return {
    type: 'state',

    status: game.status,

    matchId: game.matchId,

    players:
      Object.values(
        game.players
      ).map(player => ({
        id: player.id,

        role: player.role,

        position:
          player.position,

        rotation:
          player.rotation,

        health:
          player.health,

        alive:
          player.state === 'alive',

        kills:
          player.kills,

        weapon:
          player.weapon,

        ammo:
          player.ammo,

        reserveAmmo:
          player.reserveAmmo,

        reloading:
          player.reloading
      })),

    zone: {
      x: game.zone.x,
      z: game.zone.z,
      radius: game.zone.radius,
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
          item =>
            !item.picked
        )
        .map(item => ({
          id: item.id,
          position: item.position,
          weapon: item.weapon
        })),

    winner:
      game.winner
  };
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
      players >= MAX_PLAYERS
    ) {
      if (
        spectators <
        MAX_SPECTATORS
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
        MAX_SPECTATORS
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
      }
    );

    sendJSON(ws, {
      type: 'init',

      id: player.id,

      role: player.role,

      worldSize:
        WORLD_SIZE,

      config: {
        moveSpeed:
          MOVE_SPEED,

        sprintSpeed:
          SPRINT_SPEED,

        playerHeight:
          PLAYER_HEIGHT,

        eyeHeight:
          PLAYER_EYE_HEIGHT,

        weapons:
          WEAPONS
      },

      status:
        game.status
    });

    console.log(
      `CONNECT ${player.id} ${player.role}`
    );

    ws.on(
      'message',
      raw => {

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

        if (
          player.role === 'spectator'
        ) {
          return;
        }

        switch (data.type) {

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
              'string'
            ) {
              pickupLoot(
                player,
                data.lootId
              );
            }

            break;
          }

          case 'ping': {

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
          `DISCONNECT ${player.id}`
        );

        if (
          game.status === 'playing'
        ) {
          checkMatchEnd();
        }

        if (
          game.status === 'waiting'
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

const FIXED_DT =
  1 / TICK_RATE;

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
    Math.min(
      frame,
      0.1
    );

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

        const player =
          game.players[id];

        if (
          player.role === 'player' &&
          player.state === 'alive'
        ) {

          applyMovement(
            player,
            FIXED_DT
          );

          updateReload(
            player
          );
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
    BROADCAST_RATE
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

app.get(
  '/health',
  (req, res) => {
    res.json({
      status: 'ok',
      game: 'battle-royale',
      players:
        countPlayers()
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  () => {

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
      `🌍 World: ${WORLD_SIZE}x${WORLD_SIZE}`
    );

    console.log(
      `👥 Players: ${MAX_PLAYERS}`
    );

    console.log(
      `👁 Spectators: ${MAX_SPECTATORS}`
    );

    console.log(
      `⚙ Tick: ${TICK_RATE} Hz`
    );

    console.log(
      `📡 Broadcast: ${BROADCAST_RATE} Hz`
    );

    console.log(
      `🔫 Weapons: ${Object.keys(WEAPONS).join(', ')}`
    );

    console.log(
      '================================'
    );
  }
);
