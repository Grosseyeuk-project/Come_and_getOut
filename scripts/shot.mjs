#!/usr/bin/env node
// Headless screenshot + smoke-test tool.
// Usage: node scripts/shot.mjs [--seed 123] [--scenarios title,spawn,move,combat,loot,inventory,death,extract,overview,autoplay]
//        [--time 90 (autoplay seconds)] [--palette dusk|night|toxic|ash]
//        [--out DIR] [--build] [--w 1280 --h 720] [--q low|med|high] [--wait 0] [--eval "js"]
// Serves dist/ (builds it if missing or --build), loads the game in Chromium (SwiftShader WebGL),
// drives it through window.__game and saves PNGs. Exits non-zero on console/page errors.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const seed = opt('seed', '1337');
const scenarios = String(opt('scenarios', 'title,spawn,combat,loot,inventory')).split(',');
const out = opt('out', process.env.SHOT_DIR || '/tmp/claude-0/-home-user-Come-and-getOut/a4049913-d513-568a-bc44-88f46d1f3a52/scratchpad/shots');
const W = +opt('w', 1280), H = +opt('h', 720), Q = opt('q', 'med');
mkdirSync(out, { recursive: true });

const dist = join(root, 'dist');
if (opt('build', false) || !existsSync(join(dist, 'index.html'))) { console.log('[shot] building...'); execSync('npx vite build', { cwd: root, stdio: 'inherit' }); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error') errors.push(t); if (m.type() === 'error' || m.type() === 'warning' || opt('verbose', false)) console.log(`[page:${m.type()}] ${t}`); });
page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', e); });

const shot = async (name) => { const f = join(out, `${name}_s${seed}.png`); await page.screenshot({ path: f }); console.log('[shot] saved', f); };
const g = (fn, arg) => page.evaluate(fn, arg);
const t0 = Date.now();
await page.goto(`http://localhost:${port}/?seed=${seed}&q=${Q}${opt('palette', '') ? '&palette=' + opt('palette') : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state().ready, null, { timeout: 120000 });
console.log(`[shot] game ready in ${Date.now() - t0}ms`);
// manual mode: stop the rAF loop so each screenshot shows exactly what we rendered (SwiftShader is slow)
await g(() => window.__game.manual(true));
const frames = (n) => g((n) => window.__game.renderFrames(n), n);

for (const sc of scenarios) {
  try {
    if (sc === 'title') { await frames(2); await shot('title'); continue; }
    if (sc === 'ui') { // real DOM click path: title -> Deploy -> playing
      if ((await g(() => window.__game.state().mode)) === 'title') { await page.fill('#seedin', String(seed)); await page.click('#deploy'); }
      await page.waitForFunction(() => window.__game.state().mode === 'playing', null, { timeout: 60000 });
      await frames(2); await shot('ui_deploy'); continue;
    }
    await g(() => { if (window.__game.state().mode !== 'playing') window.__game.start(); });
    if (sc === 'spawn') { await g(() => window.__game.advance(1.0)); await frames(3); await shot('spawn'); }
    else if (sc === 'move') {
      await g(() => { window.__game.input.simKey('KeyW', true); window.__game.input.simKey('KeyD', true); window.__game.advance(1.2); window.__game.input.simKey('KeyW', false); window.__game.input.simKey('KeyD', false); });
      await frames(3); await shot('move');
    } else if (sc === 'combat') {
      await g(() => { const s = window.__game.state(); window.__game.godMode(true); window.__game.spawnEnemy('raider', s.player.x + 7, s.player.z - 5); window.__game.spawnEnemy('mutant', s.player.x + 8, s.player.z + 2); window.__game.spawnEnemy('raider', s.player.x - 3, s.player.z - 9); window.__game.advance(0.6); window.__game.aimAt(s.player.x + 7, s.player.z - 5); window.__game.input.mouse.down = true; window.__game.advance(0.35); });
      await frames(2); await shot('combat');
      await g(() => { window.__game.advance(0.8); });
      await frames(2); await shot('combat2');
      await g(() => { window.__game.input.mouse.down = false; });
    } else if (sc === 'loot') {
      await g(() => { const s = window.__game.state(); ['common', 'uncommon', 'rare', 'epic', 'legendary'].forEach((r, i) => window.__game.giveLoot(r, s.player.x + 2 + i * 1.3, s.player.z + 2)); window.__game.advance(0.5); });
      await frames(3); await shot('loot');
    } else if (sc === 'inventory') { await g(() => window.__game.toggleInventory(true)); await frames(2); await shot('inventory'); await g(() => window.__game.toggleInventory(false)); }
    else if (sc === 'death') { await g(() => { window.__game.godMode(false); window.__game.damagePlayer(9999); window.__game.advance(2.5); }); await frames(2); await shot('death'); }
    else if (sc === 'extract') {
      await g(() => { const s = window.__game.state(); window.__game.godMode(true); window.__game.teleport(s.extraction.x, s.extraction.z); window.__game.advance(1.5); }); await frames(2); await shot('extract_zone');
      await g(() => { const G = window.__game; for (let i = 0; i < 40 && G.state().mode === 'playing'; i++) G.advance(0.5); G.advance(1.4); }); await frames(2); await shot('extract_seq');
      await g(() => window.__game.advance(2.6)); await page.waitForTimeout(2600); await frames(2); await shot('extracted');
    }
    else if (sc === 'crate') {
      const r = await g(() => { const G = window.__game, gm = G.game, p = gm.player.pos; const c = gm.loot.crates.filter((c) => !c.opened).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0]; if (!c) return 'no crate'; G.teleport(c.x + 1.2, c.z + 0.6); G.advance(0.1); G.input.simKey('KeyE', true); G.advance(1 / 60); G.input.simKey('KeyE', false); G.advance(0.8); return { tier: c.tier, opened: c.opened, drops: gm.loot.drops.length }; });
      console.log('[crate]', JSON.stringify(r)); await frames(2); await shot('crate');
      const r2 = await g(() => { const G = window.__game, gm = G.game; const d = gm.loot.drops.find((d) => d.item.kind === 'weapon'); if (!d) return 'no weapon drop'; G.teleport(d.x + 0.5, d.z); G.advance(0.2); G.input.simKey('KeyE', true); G.advance(1 / 60); G.input.simKey('KeyE', false); G.advance(0.2); return { backpack: gm.player.backpack.length, name: d.item.name }; });
      console.log('[pickup]', JSON.stringify(r2));
    }
    else if (sc === 'autoplay') { const r = await g((s) => window.__game.autoplay(s), +opt('time', 90)); console.log('[autoplay]', JSON.stringify(r)); await frames(2); await shot('autoplay'); }
    else if (sc === 'overview') { await g(() => window.__game.setZoom(2.4)); await frames(2); await shot('overview'); await g(() => window.__game.setZoom(1)); }
    else if (sc === 'eval') { console.log(await page.evaluate(String(opt('eval', '0')))); await frames(2); await shot('eval'); }
  } catch (e) { errors.push(`scenario ${sc}: ${e}`); console.log('[shot] scenario failed', sc, e); }
}
const st = await g(() => window.__game.state());
writeFileSync(join(out, `state_s${seed}.json`), JSON.stringify(st, null, 2));
console.log('[shot] state', JSON.stringify({ mode: st.mode, fps: st.fps, enemies: st.enemies, player: st.player, drawCalls: st.drawCalls, triangles: st.triangles }));
await browser.close(); server.close();
if (errors.length) { console.log(`[shot] ${errors.length} console error(s)`); process.exit(1); }
console.log('[shot] OK, no console errors');
