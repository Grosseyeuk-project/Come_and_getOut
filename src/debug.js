// window.__game: debug / automation API used by scripts/shot.mjs and for manual testing in the console.
import { rollWeapon, makeConsumable, RARITY } from './combat/weapons.js';
import { RNG } from './core/rng.js';

export function installDebug(game) {
  const rng = new RNG(12345);
  const api = {
    game,
    get input() { return game.input; },
    state() {
      const p = game.player, info = game.renderer.renderer.info;
      return {
        ready: !!game.ready, mode: game.mode, seed: game.seed, palette: game.layout && game.layout.palette, quality: game.renderer.quality,
        fps: Math.round(game.fps), buildMs: game.buildMs, drawCalls: info.render.calls, triangles: info.render.triangles,
        player: p && { x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2), hp: Math.round(p.hp), weapon: p.weapon.name, mag: p.weapon.mag, ammo: { ...p.ammo }, kills: p.kills, backpack: p.backpack.length, god: p.god },
        enemies: game.enemies ? game.enemies.alive.length : 0, alerted: game.enemies ? game.enemies.alive.filter((e) => e.alert).length : 0,
        extraction: game.extraction && { x: +game.extraction.x.toFixed(1), z: +game.extraction.z.toFixed(1) }, extractT: game.extractT,
        drops: game.loot ? game.loot.drops.length : 0, crates: game.loot ? game.loot.crates.length : 0, colliders: game.col ? game.col.boxes.length : 0,
      };
    },
    start(seed) { game.startRun(seed ?? game.seed); return api.state(); },
    setSeed(seed) { game.buildWorld(seed); if (game.mode !== 'title') game.startRun(game.seed); return api.state(); },
    teleport(x, z) { game.player.placeAt(x, z); game.renderer.updateCamera(0, { x, y: 0, z, clone() { return this; } }, game.aimPoint, true); },
    spawnEnemy(type = 'raider', x, z) { const p = game.player.pos; return !!game.enemies.spawn(type, x ?? p.x + 8, z ?? p.z + 8, 'debug'); },
    giveLoot(what = 'rare', x, z) {
      const p = game.player.pos;
      const item = typeof what === 'object' ? what : RARITY[what] ? rollWeapon(rng, what) : makeConsumable(what);
      game.loot.dropItem(item, x ?? p.x + 1.5, z ?? p.z + 1.5, false);
      return item.name;
    },
    giveWeapon(rarity = 'legendary', base = null) { const it = rollWeapon(rng, rarity, base); game.player.weapons[game.player.cur] = it; game.player.equip(game.player.cur); return it.name; },
    pause(on = true) { game.setPaused(on); },
    godMode(on = true) { game.player.god = on; return on; },
    damagePlayer(n) { game.player.god = false; game.player.damage(n, game.player.pos.x + 1, game.player.pos.z); },
    killAll() { for (const e of game.enemies.alive) game.enemies.kill(e, 1, 0); },
    aimAt(x, z) { game.aimOverride = { x, z }; },
    toggleInventory(on) { game.hud.toggleInventory(on); },
    setZoom(z) { game.zoom = z; },
    // Run simulation for `sec` seconds at fixed 60Hz without rendering (deterministic-ish automation).
    advance(sec = 1) { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) { game.step(1 / 60); game.input.pressed.clear(); } return api.state(); },
    renderFrames(n = 1) { for (let i = 0; i < n; i++) { game.step(1 / 60); game.renderer.renderer.info.reset(); game.renderer.render(1 / 60); } return true; },
    manual(on = true) { game.manual = on; },
    // Simple bot: path to extraction, shoot nearest visible enemy, loot, heal. Returns a summary.
    // Useful to smoke-test balance / AI / pathing headlessly: __game.autoplay(90)
    autoplay(sec = 60, { loot = true } = {}) {
      const nav = game.nav, ex = game.extraction, pl = game.player, inp = game.input;
      const bot = Object.create(nav); bot.dist = new Float32Array(nav.dist.length); bot._heap = new Int32Array(nav._heap.length); bot._hk = new Float32Array(nav._hk.length);
      bot.computeFlow(ex.x, ex.z, 9999);
      const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
      const log = []; let t = 0, stuck = 0, last = { x: pl.pos.x, z: pl.pos.z };
      const n = Math.round(sec * 60);
      for (let i = 0; i < n && game.mode === 'playing'; i++) {
        t += 1 / 60;
        // target
        let tgt = null, best = 22;
        for (const e of game.enemies.list) { if (e.dead) continue; const d = Math.hypot(e.pos.x - pl.pos.x, e.pos.z - pl.pos.z); if (d < best && game.col.los(pl.pos.x, pl.pos.z, e.pos.x, e.pos.z, 1.3)) { best = d; tgt = e; } }
        if (tgt) { game.aimOverride = { x: tgt.pos.x + tgt.vel.x * 0.1, z: tgt.pos.z + tgt.vel.z * 0.1 }; inp.mouse.down = true; }
        else { inp.mouse.down = false; const f = bot.flowDir(pl.pos.x, pl.pos.z); if (f) game.aimOverride = { x: pl.pos.x + f.x * 5, z: pl.pos.z + f.z * 5 }; }
        // movement
        let mx = 0, mz = 0;
        const f = bot.flowDir(pl.pos.x, pl.pos.z);
        if (f) { mx = f.x; mz = f.z; } else { mx = ex.x - pl.pos.x; mz = ex.z - pl.pos.z; }
        if (loot && game.loot.focus) { const fc = game.loot.focus; if (fc.kind === 'crate' || fc.item.kind === 'weapon') inp.pressed.add('KeyE'); }
        if (tgt && best < 4 && pl.charges > 0 && Math.random() < 0.02) inp.pressed.add('Space');
        if (pl.hp < 45 && pl.medkits > 0) inp.pressed.add('KeyF');
        const yaw = game.renderer.rig.yaw, fw = -(mx * Math.sin(yaw) + mz * Math.cos(yaw)), rt = mx * Math.cos(yaw) - mz * Math.sin(yaw);
        const want = { KeyW: fw > 0.38, KeyS: fw < -0.38, KeyD: rt > 0.38, KeyA: rt < -0.38 };
        for (const k of keys) { if (want[k]) inp.keys.add(k); else inp.keys.delete(k); }
        game.step(1 / 60); inp.pressed.clear();
        if (i % 60 === 0) {
          const moved = Math.hypot(pl.pos.x - last.x, pl.pos.z - last.z); stuck = moved < 0.5 ? stuck + 1 : 0; last = { x: pl.pos.x, z: pl.pos.z };
          log.push({ t: Math.round(t), hp: Math.round(pl.hp), kills: pl.kills, x: Math.round(pl.pos.x), z: Math.round(pl.pos.z), d: Math.round(Math.hypot(ex.x - pl.pos.x, ex.z - pl.pos.z)), alerted: game.enemies.alive.filter((e) => e.alert).length });
        }
      }
      for (const k of keys) inp.keys.delete(k); inp.mouse.down = false;
      return { mode: game.mode, time: Math.round(t), hp: Math.round(pl.hp), kills: pl.kills, shots: pl.shotsFired, backpack: pl.backpack.length, log };
    },
  };
  window.__game = api;
  return api;
}
