const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  maxPayload: 1024 * 1024,
});

app.use(express.static(path.join(__dirname, 'public')));

// ===================== КОНФИГУРАЦИЯ =====================
const CONFIG = {
  WORLD_SIZE: 600,
  MAX_PLAYERS: 30,
  MAX_BOTS: 20,
  MOVE_SPEED: 8,
  CROUCH_SPEED_MULTIPLIER: 0.5,
  JUMP_COOLDOWN: 800,
  PLAYER_HEIGHT: 1.7,
  PLAYER_EYE_HEIGHT: 1.6,
  WEAPONS: {
    pistol: { damage: 15, range: 50, fireRate: 200, name: 'Пистолет', spread: 0.05, headshotMultiplier: 2, price: 0 },
    rifle: { damage: 25, range: 150, fireRate: 100, name: 'Автомат', spread: 0.03, headshotMultiplier: 2, price: 100 },
    sniper: { damage: 75, range: 300, fireRate: 800, name: 'Снайперка', spread: 0.01, headshotMultiplier: 3, price: 200 },
    shotgun: { damage: 40, range: 30, fireRate: 400, name: 'Дробовик', spread: 0.1, headshotMultiplier: 1.5, price: 150 },
    smg: { damage: 20, range: 80, fireRate: 80, name: 'ПП', spread: 0.04, headshotMultiplier: 2, price: 120 },
    lmg: { damage: 18, range: 120, fireRate: 60, name: 'Пулемёт', spread: 0.06, headshotMultiplier: 2, price: 180 },
  },
  ZONE: {
    startRadius: 280,
    shrinkInterval: 30000,
    shrinkSpeed: 8,
    minRadius: 5,
    damagePerSecond: 5,
    phases: [200, 140, 90, 60, 35, 15, 5],
  },
  LOOT_SPAWN_COUNT: 60,
  MIN_LOOT_DISTANCE: 5,
  TICK_RATE: 30,
  BROADCAST_RATE: 10,
  MAX_AMMO: 100,
  MIN_PLAYERS_TO_START: 2,
  MIN_SPAWN_DISTANCE: 8,
  SPAWN_MARGIN: 10,
  MAX_MESSAGE_SIZE: 1024,
  allowRespawn: false,
  ROTATE_RATE_LIMIT: 30,
  PING_RATE_LIMIT: 10,
  SHOOT_RATE_LIMIT: 20,
  MAX_MESSAGES_PER_SECOND: 30,
  BOT_AI_INTERVAL: 500,
};

// ===================== СОСТОЯНИЕ ИГРЫ =====================
const matchState = {
  status: 'waiting',
  id: null,
  players: {},
  bots: {},
  zone: {
    x: 0, z: 0, radius: CONFIG.ZONE.startRadius,
    targetRadius: CONFIG.ZONE.startRadius,
    targetX: 0, targetZ: 0,
    isShrinking: false,
    phase: 0,
    nextShrinkTime: 0,
    startX: 0, startZ: 0,
    startRadius: CONFIG.ZONE.startRadius,
    progress: 1,
    phaseTargets: CONFIG.ZONE.phases.slice(),
  },
  loot: [],
  startTime: null,
  matchEnding: false,
  winner: null,
  endTimer: null,
  lastTickTime: 0,
  accumulator: 0,
  lastBroadcastTime: 0,
  shopItems: [
    { id: 'rifle', name: 'Автомат', price: 100, type: 'weapon' },
    { id: 'sniper', name: 'Снайперка', price: 200, type: 'weapon' },
    { id: 'shotgun', name: 'Дробовик', price: 150, type: 'weapon' },
    { id: 'smg', name: 'ПП', price: 120, type: 'weapon' },
    { id: 'lmg', name: 'Пулемёт', price: 180, type: 'weapon' },
    { id: 'armor', name: 'Броня +30', price: 80, type: 'armor' },
    { id: 'medkit', name: 'Аптечка', price: 50, type: 'heal' },
  ],
};

// ===================== ВСПОМОГАТЕЛЬНЫЕ =====================
function randomPosition() {
  const half = CONFIG.WORLD_SIZE / 2 - 10;
  return {
    x: (Math.random() - 0.5) * 2 * half,
    z: (Math.random() - 0.5) * 2 * half,
  };
}

function distance2D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

function distance3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isInZone(pos) {
  return distance2D(pos, matchState.zone) <= matchState.zone.radius;
}

function randomSafeSpawn(existing = []) {
  for (let i = 0; i < 200; i++) {
    const pos = randomPosition();
    if (!isInZone(pos)) continue;
    let ok = true;
    for (const e of existing) {
      if (distance2D(pos, e) < CONFIG.MIN_SPAWN_DISTANCE) { ok = false; break; }
    }
    if (ok && distance2D(pos, matchState.zone) <= matchState.zone.radius - CONFIG.SPAWN_MARGIN) {
      return pos;
    }
  }
  return { x: matchState.zone.x, z: matchState.zone.z };
}

function generateSpawnPositions(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push(randomSafeSpawn(positions));
  }
  return positions;
}

// ===================== БОТЫ =====================
function createBot() {
  const id = 'bot_' + uuidv4();
  const pos = randomSafeSpawn([]);
  const bot = {
    id,
    role: 'bot',
    state: 'alive',
    position: pos,
    rotation: { yaw: Math.random() * 2 * Math.PI, pitch: 0 },
    health: 100,
    weapon: 'rifle',
    ammo: 60,
    kills: 0,
    lastShotTime: 0,
    targetId: null,
    lastSeen: Date.now(),
    currentInput: { forward: false, backward: false, left: false, right: false },
    crouching: false,
    aiTimer: 0,
  };
  return bot;
}

function spawnBots(count) {
  const bots = {};
  for (let i = 0; i < count; i++) {
    const bot = createBot();
    bots[bot.id] = bot;
  }
  return bots;
}

function updateBotAI(bot, deltaTime) {
  if (bot.state !== 'alive') return;
  let target = null;
  let minDist = Infinity;
  const allEntities = { ...matchState.players, ...matchState.bots };
  for (const id in allEntities) {
    if (id === bot.id) continue;
    const entity = allEntities[id];
    if (entity.role === 'bot' || entity.role === 'player') {
      if (entity.state !== 'alive') continue;
      const d = distance2D(bot.position, entity.position);
      if (d < 150 && d < minDist) {
        minDist = d;
        target = entity;
      }
    }
  }

  if (target) {
    const dx = target.position.x - bot.position.x;
    const dz = target.position.z - bot.position.z;
    bot.rotation.yaw = Math.atan2(-dx, -dz);
    if (minDist > 30) {
      bot.currentInput.forward = true;
      bot.currentInput.backward = false;
      bot.currentInput.left = false;
      bot.currentInput.right = false;
    } else if (minDist < 20) {
      bot.currentInput.forward = false;
      bot.currentInput.backward = true;
      bot.currentInput.left = false;
      bot.currentInput.right = false;
    } else {
      bot.currentInput.forward = false;
      bot.currentInput.backward = false;
      bot.currentInput.left = false;
      bot.currentInput.right = false;
    }
    if (minDist < 80 && bot.ammo > 0) {
      const now = Date.now();
      const weapon = CONFIG.WEAPONS[bot.weapon];
      if (weapon && now - bot.lastShotTime > weapon.fireRate) {
        bot.lastShotTime = now;
        const hit = performBotShot(bot, target);
        if (hit) {
          bot.ammo--;
          if (bot.ammo < 0) bot.ammo = 0;
        }
      }
    }
    bot.targetId = target.id;
  } else {
    if (Math.random() < 0.02) {
      const angle = Math.random() * 2 * Math.PI;
      bot.rotation.yaw = angle;
    }
    bot.currentInput.forward = Math.random() < 0.3;
    bot.currentInput.backward = false;
    bot.currentInput.left = false;
    bot.currentInput.right = false;
  }

  applyMovement(bot.id, deltaTime);
}

function performBotShot(bot, target) {
  const weapon = CONFIG.WEAPONS[bot.weapon];
  if (!weapon) return false;
  const dist = distance2D(bot.position, target.position);
  if (dist > weapon.range) return false;
  const hitChance = Math.max(0, 1 - (dist / weapon.range) * 0.5);
  if (Math.random() > hitChance) return false;

  let damage = weapon.damage;
  const isHeadshot = Math.random() < 0.1;
  if (isHeadshot) damage *= (weapon.headshotMultiplier || 2);
  damage = Math.round(damage);

  const targetPlayer = matchState.players[target.id];
  if (targetPlayer && targetPlayer.state === 'alive') {
    applyDamageWithArmor(targetPlayer, damage);
    if (targetPlayer.health <= 0) {
      targetPlayer.state = 'dead';
      targetPlayer.currentInput = { forward: false, backward: false, left: false, right: false };
      bot.kills = (bot.kills || 0) + 1;
      broadcastDeath(targetPlayer.id, 'bullet', bot.id);
      checkMatchEnd();
    }
    broadcastHit(bot.id, targetPlayer.id, damage, isHeadshot, bot.weapon);
    return true;
  }
  const targetBot = matchState.bots[target.id];
  if (targetBot && targetBot.state === 'alive') {
    targetBot.health = clamp(targetBot.health - damage, 0, 100);
    if (targetBot.health <= 0) {
      targetBot.state = 'dead';
      bot.kills = (bot.kills || 0) + 1;
      broadcastDeath(targetBot.id, 'bullet', bot.id);
      setTimeout(() => {
        if (matchState.bots[targetBot.id]) delete matchState.bots[targetBot.id];
      }, 5000);
    }
    broadcastHit(bot.id, targetBot.id, damage, isHeadshot, bot.weapon);
    return true;
  }
  return false;
}

// Учитываем броню: часть урона поглощается бронёй (только для игроков, у ботов брони нет)
function applyDamageWithArmor(entity, rawDamage) {
  let damage = rawDamage;
  if (entity.armor && entity.armor > 0) {
    const absorbed = Math.min(entity.armor, damage * 0.5);
    entity.armor = clamp(entity.armor - absorbed, 0, 100);
    damage -= absorbed;
  }
  entity.health = clamp(entity.health - damage, 0, 100);
}

// ===================== ДВИЖЕНИЕ (общее для всех) =====================
function applyMovement(entityId, deltaTime) {
  const entity = matchState.players[entityId] || matchState.bots[entityId];
  if (!entity || entity.state !== 'alive') return;
  const input = entity.currentInput || { forward: false, backward: false, left: false, right: false };
  const yaw = entity.rotation.yaw || 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let forwardX = -sin;
  let forwardZ = -cos;
  let rightX = cos;
  let rightZ = -sin;
  let moveX = 0, moveZ = 0;
  if (input.forward) { moveX += forwardX; moveZ += forwardZ; }
  if (input.backward) { moveX -= forwardX; moveZ -= forwardZ; }
  if (input.left) { moveX -= rightX; moveZ -= rightZ; }
  if (input.right) { moveX += rightX; moveZ += rightZ; }
  const len = Math.sqrt(moveX*moveX + moveZ*moveZ);
  if (len > 0.001) {
    const speed = entity.crouching ? CONFIG.MOVE_SPEED * CONFIG.CROUCH_SPEED_MULTIPLIER : CONFIG.MOVE_SPEED;
    moveX = (moveX / len) * speed * deltaTime;
    moveZ = (moveZ / len) * speed * deltaTime;
    entity.position.x = clamp(entity.position.x + moveX, -CONFIG.WORLD_SIZE/2 + 1, CONFIG.WORLD_SIZE/2 - 1);
    entity.position.z = clamp(entity.position.z + moveZ, -CONFIG.WORLD_SIZE/2 + 1, CONFIG.WORLD_SIZE/2 - 1);
  }
}

// ===================== ПРЫЖОК / ПРИСЕСТЬ =====================
function handleJump(playerId) {
  const player = matchState.players[playerId];
  if (!player || player.state !== 'alive') return;
  const now = Date.now();
  if (now - (player.lastJumpTime || 0) < CONFIG.JUMP_COOLDOWN) return;
  player.lastJumpTime = now;
  player.isJumping = true;
  // Прыжок носит визуальный/тактический характер (уклонение), на сервере как короткий флаг состояния
  setTimeout(() => { if (player) player.isJumping = false; }, 500);
}

function handleCrouch(playerId, value) {
  const player = matchState.players[playerId];
  if (!player || player.state !== 'alive') return;
  player.crouching = !!value;
}

// ===================== ЗОНА =====================
function initZone() {
  const z = matchState.zone;
  z.x = 0; z.z = 0;
  z.radius = CONFIG.ZONE.startRadius;
  z.targetRadius = CONFIG.ZONE.startRadius;
  z.targetX = 0; z.targetZ = 0;
  z.isShrinking = false;
  z.phase = 0;
  z.nextShrinkTime = Date.now() + CONFIG.ZONE.shrinkInterval;
  z.startX = 0; z.startZ = 0;
  z.startRadius = CONFIG.ZONE.startRadius;
  z.progress = 1;
  z.phaseTargets = CONFIG.ZONE.phases.slice();
}

function updateZone(deltaTime) {
  if (matchState.status !== 'playing') return;
  const now = Date.now();
  const z = matchState.zone;
  if (z.radius <= CONFIG.ZONE.minRadius) {
    z.radius = CONFIG.ZONE.minRadius;
    z.isShrinking = false;
    return;
  }
  if (!z.isShrinking && now >= z.nextShrinkTime) {
    const nextPhase = z.phase;
    if (nextPhase < z.phaseTargets.length) {
      z.targetRadius = z.phaseTargets[nextPhase];
      if (z.targetRadius >= z.radius) z.targetRadius = z.radius / 2;
      let newX, newZ, found = false;
      for (let i = 0; i < 200; i++) {
        const angle = Math.random() * 2 * Math.PI;
        const dist = Math.random() * (z.radius - z.targetRadius);
        const cx = z.x + Math.cos(angle) * dist;
        const cz = z.z + Math.sin(angle) * dist;
        if (cx - z.targetRadius >= -CONFIG.WORLD_SIZE/2 && cx + z.targetRadius <= CONFIG.WORLD_SIZE/2 &&
            cz - z.targetRadius >= -CONFIG.WORLD_SIZE/2 && cz + z.targetRadius <= CONFIG.WORLD_SIZE/2) {
          newX = cx; newZ = cz; found = true; break;
        }
      }
      if (!found) {
        newX = clamp(0, -CONFIG.WORLD_SIZE/2 + z.targetRadius, CONFIG.WORLD_SIZE/2 - z.targetRadius);
        newZ = clamp(0, -CONFIG.WORLD_SIZE/2 + z.targetRadius, CONFIG.WORLD_SIZE/2 - z.targetRadius);
      }
      z.startX = z.x; z.startZ = z.z; z.startRadius = z.radius;
      z.targetX = newX; z.targetZ = newZ;
      z.progress = 0;
      z.isShrinking = true;
      z.phase++;
    } else {
      z.isShrinking = false;
    }
  }
  if (z.isShrinking) {
    const shrinkAmount = CONFIG.ZONE.shrinkSpeed * deltaTime;
    z.progress = Math.min(1, z.progress + shrinkAmount / (z.startRadius - z.targetRadius + 0.001));
    const t = z.progress;
    z.x = z.startX + (z.targetX - z.startX) * t;
    z.z = z.startZ + (z.targetZ - z.startZ) * t;
    z.radius = z.startRadius + (z.targetRadius - z.startRadius) * t;
    if (z.radius <= z.targetRadius + 0.5) {
      z.radius = z.targetRadius;
      z.x = z.targetX; z.z = z.targetZ;
      z.isShrinking = false;
      z.progress = 1;
      z.nextShrinkTime = Date.now() + CONFIG.ZONE.shrinkInterval;
    }
  }
  const entities = { ...matchState.players, ...matchState.bots };
  for (const id in entities) {
    const e = entities[id];
    if (e.state !== 'alive') continue;
    if (!isInZone(e.position)) {
      e.health -= CONFIG.ZONE.damagePerSecond * deltaTime;
      if (e.health <= 0) {
        e.health = 0;
        e.state = 'dead';
        e.currentInput = { forward: false, backward: false, left: false, right: false };
        broadcastDeath(id, 'zone', null);
        if (matchState.bots[id]) {
          setTimeout(() => {
            if (matchState.bots[id]) delete matchState.bots[id];
          }, 5000);
        }
        checkMatchEnd();
      }
    }
  }
}

// ===================== ВЫСТРЕЛ (игрока) =====================
function performShot(playerId) {
  const shooter = matchState.players[playerId];
  if (!shooter || shooter.state !== 'alive') return false;
  if (matchState.status === 'ending') return false;
  const now = Date.now();
  const weaponKey = shooter.weapon || 'pistol';
  const weapon = CONFIG.WEAPONS[weaponKey];
  if (!weapon) return false;
  if (now - shooter.lastShotTime < weapon.fireRate) return false;
  shooter.lastShotTime = now;
  if (shooter.ammo <= 0) return false;
  shooter.ammo--;

  const yaw = shooter.rotation.yaw || 0;
  const pitch = shooter.rotation.pitch || 0;
  const spread = weapon.spread || 0;
  const spreadYaw = (Math.random() - 0.5) * spread * 2;
  const spreadPitch = (Math.random() - 0.5) * spread * 2;
  const finalYaw = yaw + spreadYaw;
  const finalPitch = pitch + spreadPitch;
  const dir = {
    x: -Math.sin(finalYaw) * Math.cos(finalPitch),
    y: Math.sin(finalPitch),
    z: -Math.cos(finalYaw) * Math.cos(finalPitch),
  };
  const len = Math.sqrt(dir.x*dir.x + dir.y*dir.y + dir.z*dir.z);
  if (len > 0) { dir.x /= len; dir.y /= len; dir.z /= len; }
  const startPos = { x: shooter.position.x, y: CONFIG.PLAYER_EYE_HEIGHT, z: shooter.position.z };

  let hitTargetId = null;
  let hitProj = Infinity;
  let headshot = false;

  const targets = { ...matchState.players, ...matchState.bots };
  for (const id in targets) {
    if (id === playerId) continue;
    const target = targets[id];
    if (target.state !== 'alive') continue;
    // Приседающая цель ниже — уменьшаем эффективную высоту тела/головы
    const crouchOffset = target.crouching ? 0.5 : 0;
    const tPos = { x: target.position.x, y: (CONFIG.PLAYER_HEIGHT/2) - crouchOffset, z: target.position.z };
    const dist3D = distance3D(startPos, tPos);
    if (dist3D > weapon.range) continue;
    const to = { x: tPos.x - startPos.x, y: tPos.y - startPos.y, z: tPos.z - startPos.z };
    const proj = to.x*dir.x + to.y*dir.y + to.z*dir.z;
    if (proj > 0 && proj <= weapon.range) {
      const close = { x: startPos.x + dir.x * proj, y: startPos.y + dir.y * proj, z: startPos.z + dir.z * proj };
      const d = distance3D(close, tPos);
      if (d < 0.6 && proj < hitProj) {
        hitProj = proj;
        hitTargetId = id;
        headshot = false;
      }
      const headPos = { x: target.position.x, y: CONFIG.PLAYER_HEIGHT - 0.1 - crouchOffset, z: target.position.z };
      const toHead = { x: headPos.x - startPos.x, y: headPos.y - startPos.y, z: headPos.z - startPos.z };
      const projHead = toHead.x*dir.x + toHead.y*dir.y + toHead.z*dir.z;
      if (projHead > 0 && projHead <= weapon.range) {
        const closeHead = { x: startPos.x + dir.x * projHead, y: startPos.y + dir.y * projHead, z: startPos.z + dir.z * projHead };
        const dHead = distance3D(closeHead, headPos);
        if (dHead < 0.3 && projHead < hitProj) {
          hitProj = projHead;
          hitTargetId = id;
          headshot = true;
        }
      }
    }
  }

  if (hitTargetId) {
    const target = targets[hitTargetId];
    if (!target || target.state !== 'alive') return false;
    let damage = weapon.damage;
    if (headshot) damage *= (weapon.headshotMultiplier || 2);
    damage = Math.round(damage);

    if (matchState.players[hitTargetId]) {
      applyDamageWithArmor(target, damage);
    } else {
      target.health = clamp(target.health - damage, 0, 100);
    }

    if (target.health <= 0) {
      target.health = 0;
      target.state = 'dead';
      target.currentInput = { forward: false, backward: false, left: false, right: false };
      shooter.kills = (shooter.kills || 0) + 1;
      shooter.currency = (shooter.currency || 0) + 50; // награда за килл
      broadcastDeath(hitTargetId, 'bullet', playerId);
      if (matchState.bots[hitTargetId]) {
        setTimeout(() => {
          if (matchState.bots[hitTargetId]) delete matchState.bots[hitTargetId];
        }, 5000);
      }
    }
    broadcastHit(playerId, hitTargetId, damage, headshot, weaponKey);
    if (target.state === 'dead') checkMatchEnd();
    return true;
  }
  return false;
}

// ===================== LOOT / SHOP / ROTATE =====================
function generateLoot() {
  const items = [];
  const weaponKeys = Object.keys(CONFIG.WEAPONS);
  let attempts = 0;
  while (items.length < CONFIG.LOOT_SPAWN_COUNT && attempts < 1000) {
    attempts++;
    const pos = randomPosition();
    if (!isInZone(pos)) continue;
    let tooClose = false;
    for (const existing of items) {
      if (distance2D(pos, existing.position) < CONFIG.MIN_LOOT_DISTANCE) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const key = weaponKeys[Math.floor(Math.random() * weaponKeys.length)];
    const ammo = Math.floor(Math.random() * 30) + 20;
    items.push({
      id: uuidv4(),
      position: pos,
      weapon: key,
      ammo: ammo,
      picked: false,
    });
  }
  return items;
}

function handlePickup(playerId, lootId) {
  const player = matchState.players[playerId];
  if (!player || player.state !== 'alive') return;
  const item = matchState.loot.find(l => l.id === lootId && !l.picked);
  if (!item) return;
  if (distance2D(player.position, item.position) > 3) return;
  item.picked = true;
  player.weapon = item.weapon;
  player.ammo = clamp(item.ammo || 30, 0, CONFIG.MAX_AMMO);
  player.lastShotTime = 0;
  broadcastLootPickup(lootId, playerId);
}

function handleRotate(playerId, yaw, pitch) {
  const player = matchState.players[playerId];
  if (!player || player.state !== 'alive') return;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
  const now = Date.now();
  if (now - player.lastRotateTime < 1000 / CONFIG.ROTATE_RATE_LIMIT) return;
  player.lastRotateTime = now;
  const normalizedYaw = ((yaw % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  const clampedPitch = clamp(pitch, -Math.PI/2 + 0.01, Math.PI/2 - 0.01);
  player.rotation.yaw = normalizedYaw;
  player.rotation.pitch = clampedPitch;
}

function handleShopBuy(playerId, itemId) {
  const player = matchState.players[playerId];
  if (!player || player.state !== 'alive') return;
  const shopItem = matchState.shopItems.find(i => i.id === itemId);
  if (!shopItem) return;
  const currency = player.currency || 0;
  if (currency < shopItem.price) return;
  player.currency = currency - shopItem.price;

  if (shopItem.type === 'weapon') {
    player.weapon = shopItem.id;
    player.ammo = 30;
    player.lastShotTime = 0;
  } else if (shopItem.type === 'armor') {
    player.armor = clamp((player.armor || 0) + 30, 0, 100);
  } else if (shopItem.type === 'heal') {
    player.health = clamp(player.health + 30, 0, 100);
  }
  broadcastShopUpdate(playerId);
}

// ===================== РАССЫЛКИ =====================
function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(data); } catch (e) {}
  }
}

function broadcastState() {
  const players = Object.values(matchState.players).filter(p => p.role === 'player');
  const bots = Object.values(matchState.bots).filter(b => b.state === 'alive');
  const state = {
    type: 'state',
    players: players.map(p => ({
      id: p.id,
      position: p.position,
      rotation: p.rotation,
      health: p.health,
      alive: p.state === 'alive',
      kills: p.kills || 0,
      weapon: p.weapon,
      ammo: p.ammo,
      currency: p.currency || 0,
      armor: p.armor || 0,
      crouching: !!p.crouching,
      isJumping: !!p.isJumping,
    })),
    bots: bots.map(b => ({
      id: b.id,
      position: b.position,
      rotation: b.rotation,
      health: b.health,
      alive: b.state === 'alive',
      weapon: b.weapon,
    })),
    zone: {
      x: matchState.zone.x,
      z: matchState.zone.z,
      radius: matchState.zone.radius,
      targetRadius: matchState.zone.targetRadius,
      isShrinking: matchState.zone.isShrinking,
      phase: matchState.zone.phase,
      nextShrinkTime: matchState.zone.nextShrinkTime,
      progress: matchState.zone.progress,
      startRadius: matchState.zone.startRadius,
      startX: matchState.zone.startX,
      startZ: matchState.zone.startZ,
    },
    loot: matchState.loot.filter(l => !l.picked).map(l => ({ id: l.id, position: l.position, weapon: l.weapon })),
    shop: matchState.shopItems,
    matchActive: matchState.status === 'playing',
    matchEnding: matchState.status === 'ending',
    status: matchState.status,
    winner: matchState.winner,
  };
  const msg = JSON.stringify(state);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
}

function broadcastDeath(playerId, cause, killerId) {
  const msg = JSON.stringify({ type: 'death', playerId, cause, killerId: killerId || null });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
}

function broadcastHit(shooterId, targetId, damage, headshot, weapon) {
  const msg = JSON.stringify({ type: 'hit', shooterId, targetId, damage, headshot, weapon });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
}

function broadcastLootPickup(lootId, playerId) {
  const msg = JSON.stringify({ type: 'loot-pickup', lootId, playerId });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
}

function broadcastShopUpdate(playerId) {
  const msg = JSON.stringify({ type: 'shop-update', playerId });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
}

function broadcastWinner(playerId) {
  if (matchState.status === 'ending') return;
  matchState.status = 'ending';
  matchState.winner = playerId;
  const msg = JSON.stringify({ type: 'winner', playerId, nextMatchIn: 5000 });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
  if (matchState.endTimer) clearTimeout(matchState.endTimer);
  matchState.endTimer = setTimeout(() => {
    matchState.status = 'waiting';
    matchState.winner = null;
    matchState.endTimer = null;
    for (const id in matchState.players) {
      const p = matchState.players[id];
      p.role = 'player';
      p.state = 'waiting';
    }
    matchState.bots = spawnBots(CONFIG.MAX_BOTS);
    const participants = Object.values(matchState.players).filter(p => p.role === 'player');
    if (participants.length >= CONFIG.MIN_PLAYERS_TO_START) {
      startMatch();
    } else {
      broadcastState();
    }
  }, 5000);
}

function broadcastDraw() {
  if (matchState.status === 'ending') return;
  matchState.status = 'draw';
  const msg = JSON.stringify({ type: 'draw', nextMatchIn: 3000 });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) safeSend(c, msg); });
  if (matchState.endTimer) clearTimeout(matchState.endTimer);
  matchState.endTimer = setTimeout(() => {
    matchState.status = 'waiting';
    matchState.winner = null;
    matchState.endTimer = null;
    for (const id in matchState.players) {
      const p = matchState.players[id];
      p.role = 'player';
      p.state = 'waiting';
    }
    matchState.bots = spawnBots(CONFIG.MAX_BOTS);
    const participants = Object.values(matchState.players).filter(p => p.role === 'player');
    if (participants.length >= CONFIG.MIN_PLAYERS_TO_START) {
      startMatch();
    } else {
      broadcastState();
    }
  }, 3000);
}

// ===================== УПРАВЛЕНИЕ МАТЧЕМ =====================
function startMatch() {
  if (matchState.status === 'playing') return;
  if (matchState.status === 'ending') return;
  const players = Object.values(matchState.players).filter(p => p.role === 'player');
  if (players.length < CONFIG.MIN_PLAYERS_TO_START) return;
  if (matchState.endTimer) clearTimeout(matchState.endTimer);
  matchState.status = 'playing';
  matchState.id = uuidv4();
  matchState.startTime = Date.now();
  matchState.winner = null;
  initZone();
  matchState.loot = generateLoot();
  matchState.bots = spawnBots(CONFIG.MAX_BOTS);
  const playerIds = players.map(p => p.id);
  const spawnPositions = generateSpawnPositions(playerIds.length);
  playerIds.forEach((id, i) => {
    const p = matchState.players[id];
    p.position = spawnPositions[i] || { x: 0, z: 0 };
    p.health = 100;
    p.state = 'alive';
    p.kills = 0;
    p.weapon = 'pistol';
    p.ammo = 30;
    p.rotation = { yaw: 0, pitch: 0 };
    p.lastShotTime = 0;
    p.lastRotateTime = 0;
    p.currentInput = { forward: false, backward: false, left: false, right: false };
    p.currency = 100;
    p.armor = 0;
    p.crouching = false;
    p.isJumping = false;
    p.lastJumpTime = 0;
  });
  console.log(`🎮 Матч ${matchState.id} начат! Игроков: ${playerIds.length}, ботов: ${Object.keys(matchState.bots).length}`);
  broadcastState();
}

function checkMatchEnd() {
  if (matchState.status !== 'playing') return;
  const alivePlayers = Object.values(matchState.players).filter(p => p.role === 'player' && p.state === 'alive');
  const aliveBots = Object.values(matchState.bots).filter(b => b.state === 'alive');
  const totalAlive = alivePlayers.length + aliveBots.length;
  if (totalAlive === 0) {
    broadcastDraw();
    return;
  }
  if (alivePlayers.length === 0 && aliveBots.length > 0) {
    broadcastDraw();
    return;
  }
  if (alivePlayers.length === 1 && aliveBots.length === 0) {
    broadcastWinner(alivePlayers[0].id);
  }
}

// ===================== ВЕБСОКЕТ =====================
wss.on('connection', (ws) => {
  const total = Object.keys(matchState.players).length;
  if (total >= CONFIG.MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: 'Сервер заполнен' }));
    ws.close();
    return;
  }
  const isSpectator = matchState.status === 'playing' || matchState.status === 'ending' || matchState.status === 'draw';
  const id = uuidv4();
  const player = {
    id,
    ws,
    role: isSpectator ? 'spectator' : 'player',
    state: isSpectator ? 'spectator' : 'waiting',
    position: { x: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0 },
    health: 100,
    kills: 0,
    weapon: 'pistol',
    ammo: 30,
    lastShotTime: 0,
    lastRotateTime: 0,
    lastPingTime: 0,
    lastJumpTime: 0,
    currentInput: { forward: false, backward: false, left: false, right: false },
    currency: isSpectator ? 0 : 100,
    armor: 0,
    crouching: false,
    isJumping: false,
    _messageCount: 0,
    _lastMessageReset: 0,
  };
  matchState.players[id] = player;

  ws.send(JSON.stringify({
    type: 'init',
    id,
    worldSize: CONFIG.WORLD_SIZE,
    config: {
      moveSpeed: CONFIG.MOVE_SPEED,
      weapons: CONFIG.WEAPONS,
      playerHeight: CONFIG.PLAYER_HEIGHT,
      eyeHeight: CONFIG.PLAYER_EYE_HEIGHT,
    },
    isSpectator: player.role === 'spectator',
    status: matchState.status,
  }));

  if (matchState.status === 'waiting') {
    const participants = Object.values(matchState.players).filter(p => p.role === 'player');
    if (participants.length >= CONFIG.MIN_PLAYERS_TO_START) {
      startMatch();
    }
  }
  broadcastState();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    if (message.length > CONFIG.MAX_MESSAGE_SIZE) {
      safeSend(ws, JSON.stringify({ type: 'error', message: 'Message too large' }));
      return;
    }
    try {
      const data = JSON.parse(message);
      if (!data || typeof data !== 'object') return;
      const player = matchState.players[id];
      if (!player) return;
      const now = Date.now();
      if (now - player._lastMessageReset > 1000) { player._messageCount = 0; player._lastMessageReset = now; }
      player._messageCount = (player._messageCount || 0) + 1;
      if (player._messageCount > CONFIG.MAX_MESSAGES_PER_SECOND) return;
      player.lastSeen = now;
      if (player.role === 'spectator') return;
      if (player.state !== 'alive') return;
      if (matchState.status === 'ending' || matchState.status === 'draw') return;

      switch (data.type) {
        case 'move-input': {
          const input = data.input || {};
          player.currentInput.forward = (input.forward === true || input.forward === 1);
          player.currentInput.backward = (input.backward === true || input.backward === 1);
          player.currentInput.left = (input.left === true || input.left === 1);
          player.currentInput.right = (input.right === true || input.right === 1);
          break;
        }
        case 'rotate': {
          const yaw = parseFloat(data.yaw);
          const pitch = parseFloat(data.pitch);
          if (Number.isFinite(yaw) && Number.isFinite(pitch)) handleRotate(id, yaw, pitch);
          break;
        }
        case 'shoot': {
          performShot(id);
          break;
        }
        case 'pickup': {
          if (data.lootId && typeof data.lootId === 'string' && data.lootId.length < 100) {
            handlePickup(id, data.lootId);
          }
          break;
        }
        case 'shop-buy': {
          if (data.itemId && typeof data.itemId === 'string') {
            handleShopBuy(id, data.itemId);
          }
          break;
        }
        case 'jump': {
          handleJump(id);
          break;
        }
        case 'crouch': {
          handleCrouch(id, data.value);
          break;
        }
        case 'ping': {
          if (now - player.lastPingTime < 1000 / CONFIG.PING_RATE_LIMIT) break;
          player.lastPingTime = now;
          safeSend(ws, JSON.stringify({ type: 'pong' }));
          break;
        }
        default: break;
      }
    } catch (err) {}
  });

  ws.on('close', () => {
    if (!matchState.players[id]) return;
    delete matchState.players[id];
    if (matchState.status === 'playing') {
      checkMatchEnd();
      const participants = Object.values(matchState.players).filter(p => p.role === 'player');
      if (participants.length < CONFIG.MIN_PLAYERS_TO_START) {
        matchState.status = 'waiting';
        broadcastState();
      }
    } else if (matchState.status === 'waiting') {
      const participants = Object.values(matchState.players).filter(p => p.role === 'player');
      if (participants.length >= CONFIG.MIN_PLAYERS_TO_START) startMatch();
    }
    broadcastState();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    ws.close();
  });
});

// ===================== HEARTBEAT =====================
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ===================== ИГРОВОЙ ЦИКЛ =====================
const TICK_INTERVAL = 1000 / CONFIG.TICK_RATE;
let lastTick = performance.now();
let accumulator = 0;

function gameLoop() {
  const now = performance.now();
  let delta = (now - lastTick) / 1000;
  lastTick = now;
  if (delta > 0.1) delta = 0.1;
  accumulator += delta;
  while (accumulator >= TICK_INTERVAL / 1000) {
    const dt = TICK_INTERVAL / 1000;
    if (matchState.status === 'playing') {
      updateZone(dt);
      for (const id in matchState.bots) {
        const bot = matchState.bots[id];
        if (bot.state === 'alive') {
          updateBotAI(bot, dt);
          applyMovement(id, dt);
        }
      }
      for (const id in matchState.players) {
        const p = matchState.players[id];
        if (p.role === 'player' && p.state === 'alive') {
          applyMovement(id, dt);
        }
      }
      checkMatchEnd();
    }
    accumulator -= TICK_INTERVAL / 1000;
  }
  const nowMs = Date.now();
  if (nowMs - matchState.lastBroadcastTime >= 1000 / CONFIG.BROADCAST_RATE) {
    if (Object.keys(matchState.players).length > 0 || Object.keys(matchState.bots).length > 0) {
      broadcastState();
    }
    matchState.lastBroadcastTime = nowMs;
  }
  setImmediate(gameLoop);
}

gameLoop();

// ===================== ЗАПУСК =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🌍 Макс. игроков: ${CONFIG.MAX_PLAYERS}, ботов: ${CONFIG.MAX_BOTS}`);
  console.log(`🔫 Оружие: ${Object.keys(CONFIG.WEAPONS).join(', ')}`);
});
