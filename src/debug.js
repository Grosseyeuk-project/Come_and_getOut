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
  };
  window.__game = api;
  return api;
}
