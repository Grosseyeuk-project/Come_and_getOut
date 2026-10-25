// Game orchestration: world (re)building per seed, run state machine (title -> playing -> dead/extracted),
// the frame loop, aiming, extraction logic and wiring between systems.
import * as THREE from 'three';
import { Renderer } from './render/renderer.js';
import { cutUniforms } from './render/materials.js';
import { Input } from './core/input.js';
import { RNG, damp } from './core/rng.js';
import { CollisionWorld } from './core/collision.js';
import { NavGrid } from './core/nav.js';
import { generateLayout, populate, HALF } from './world/mapgen.js';
import { Environment, worldUniforms } from './world/environment.js';
import { Lighting } from './world/lighting.js';
import { Effects } from './fx/effects.js';
import { Player } from './entities/player.js';
import { EnemyManager } from './entities/enemies.js';
import { Combat } from './combat/combat.js';
import { LootManager } from './loot/loot.js';
import { HUD } from './ui/hud.js';
import { Audio } from './audio/audio.js';
import * as T from './render/textures.js';

export class Game {
  constructor(container) {
    this.container = container;
    this.renderer = new Renderer(container);
    this.input = new Input(this.renderer.renderer.domElement);
    this.audio = new Audio();
    const qs = new URLSearchParams(location.search);
    this.seed = qs.has('seed') ? (parseInt(qs.get('seed'), 10) >>> 0) : Math.floor(Math.random() * 1e6);
    this.mode = 'title'; this.paused = false;
    this.fps = 60; this.runTime = 0;
    this.extractDur = 20; this.extractT = 0;
    this.hurtFlash = 0;
    this.raycaster = new THREE.Raycaster(); this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.2);
    this.aimPoint = new THREE.Vector3(); this.aimOverride = null;
    addEventListener('mousemove', () => { this.aimOverride = null; });
    this.hud = new HUD(this);
    this.buildWorld(this.seed);
    this.hud.setScreen('title');
    this.ready = true;
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    if (qs.get('autostart') === '1') this.startRun(this.seed);
  }

  disposeWorld() {
    if (!this.scene) return;
    this.enemies.clear(); this.loot.clear(); this.combat.clear(); this.fx.dispose(); this.player.dispose(); this.env.dispose();
    this.scene.traverse((o) => { if (o.isLight && o.dispose) o.dispose(); });
    if (this.scene.environment) this.scene.environment.dispose();
    this.scene.clear();
  }

  buildWorld(seed) {
    const t0 = performance.now();
    this.disposeWorld();
    this.seed = seed >>> 0;
    const scene = this.scene = new THREE.Scene();
    this.layout = generateLayout(this.seed);
    this.lighting = new Lighting(scene, this.renderer.renderer, this.layout.palette, this.renderer.quality);
    this.col = new CollisionWorld(-HALF, -HALF, HALF, HALF, 4);
    this.env = new Environment(scene, this.layout, this.col, this.lighting);
    this.nav = new NavGrid(this.col, 1, 0.45);
    const pop = this.pop = populate(this.layout, this.nav, new RNG(this.seed ^ 0xbeef));
    this.fx = new Effects(scene, this.lighting, this.renderer);
    this.fx.setAtmosphere(this.lighting.p);
    for (const f of this.env.fires) this.fx.addFire(f.x, f.y, f.z, f.s);
    for (const s of this.env.smokes) this.fx.addSmoker(s.x, s.y, s.z, s.s);
    for (const f of this.env.flares) this.fx.addFlare(f.x, f.z);
    this.combat = new Combat(this);
    this.enemies = new EnemyManager(this);
    this.loot = new LootManager(this);
    this.player = new Player(this);
    this.player.placeAt(pop.spawn.x, pop.spawn.z);
    for (const e of pop.enemies) this.enemies.spawn(e.type, e.x, e.z, e.group);
    for (const c of pop.crates) this.loot.spawnCrate(c);
    this.extraction = pop.extraction;
    this.buildExtraction(pop.extraction);
    // palette-driven grading
    if (!this.renderer.composer) this.renderer.setupPost(scene);
    else { this.renderer.composer.passes[0].scene = scene; if (this.renderer.ao) this.renderer.ao.scene = scene; }
    const p = this.lighting.p, gu = this.renderer.grade.uniforms;
    gu.uTint.value.setRGB(...p.tint); gu.uShadowTint.value.setRGB(...p.shadowTint); gu.uSat.value = p.sat;
    this.renderer.renderer.toneMappingExposure = p.exposure;
    this.extractT = 0; this.runTime = 0; this.flowT = 0; this.deathT = 0; this.waveSpawned = false; this.waveT = 1; this.waveRng = null;
    this.worldFresh = true;
    this.hud.newRun();
    this.renderer.updateCamera(0, new THREE.Vector3(this.player.pos.x, 0, this.player.pos.z), new THREE.Vector3(this.player.pos.x, 0, this.player.pos.z), true);
    this.buildMs = Math.round(performance.now() - t0);
    console.log(`[world] seed ${this.seed} (${this.layout.palette}) built in ${this.buildMs}ms: ${this.col.boxes.length} colliders, ${pop.enemies.length} enemies, ${pop.crates.length} crates`);
  }

  buildExtraction(ex) {
    const g = new THREE.Group(); g.position.set(ex.x, 0, ex.z);
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    x.strokeStyle = 'rgba(230,220,180,0.9)'; x.lineWidth = 10; x.beginPath(); x.arc(128, 128, 110, 0, 7); x.stroke();
    x.fillStyle = 'rgba(230,220,180,0.9)'; x.fillRect(78, 68, 22, 120); x.fillRect(156, 68, 22, 120); x.fillRect(78, 117, 100, 22);
    for (let i = 0; i < 300; i++) { x.clearRect(Math.random() * 256, Math.random() * 256, Math.random() * 10, Math.random() * 10); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const pad = new THREE.Mesh(new THREE.CircleGeometry(4.2, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }));
    pad.position.y = 0.06; pad.receiveShadow = true; g.add(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.0, 4.3, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.2, 0.8), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    ring.position.y = 0.08; g.add(ring); this.exRing = ring;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.6, 40, 16, 1, true).translate(0, 20, 0), new THREE.MeshBasicMaterial({ map: T.beamTex(), color: new THREE.Color(0.12, 0.6, 0.25), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    g.add(beam);
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.6; const f = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0, emissive: 0x30ff70, emissiveIntensity: 6 })); f.position.set(Math.cos(a) * 3.7, 0.15, Math.sin(a) * 3.7); g.add(f); }
    this.scene.add(g); this.exGroup = g;
    this.lighting.addSource(new THREE.Vector3(ex.x, 1.5, ex.z), 0x40ff80, 30, 14, 'pulse', { priority: 2 });
    this.fx.addSmoker(ex.x + 2.5, 0.3, ex.z + 2.5, 0.6);
    this.exSmoke = this.fx.smokers[this.fx.smokers.length - 1]; this.exSmoke.green = true;
  }

  startRun(seed) {
    if (seed !== this.seed || !this.worldFresh) this.buildWorld(seed);
    this.worldFresh = false;
    this.mode = 'playing'; this.paused = false;
    this.hud.setScreen('playing');
    try { history.replaceState(null, '', `?seed=${this.seed}${location.search.includes('q=') ? '&q=' + new URLSearchParams(location.search).get('q') : ''}`); } catch (e) { /* file:// */ }
    this.hud.toast(`District #${this.seed} — find the extraction`, '#ffb347');
  }
  // UI path: show the loading overlay for a frame before the blocking world build
  startRunAsync(seed) {
    const needBuild = seed !== this.seed || !this.worldFresh;
    const ov = document.getElementById('loading');
    if (needBuild && ov) { ov.style.display = 'flex'; requestAnimationFrame(() => setTimeout(() => { this.startRun(seed); ov.style.display = 'none'; }, 0)); }
    else this.startRun(seed);
  }
  showTitle() { this.mode = 'title'; this.hud.setScreen('title'); }
  setPaused(p) { if (this.mode !== 'playing' && this.mode !== 'paused') return; this.mode = p ? 'paused' : 'playing'; this.hud.setScreen(this.mode); }

  onPlayerHurt(amount) {
    this.hurtFlash = Math.min(1, this.hurtFlash + amount / 30);
    this.renderer.addTrauma(0.25 + amount / 60);
    this.audio.play('hurt', null, { minGap: 0.1 });
  }
  onPlayerDeath() {
    this.audio.play('death');
    this.deathT = 1.8; // seconds of sim time before the death screen
  }

  updateAim() {
    if (this.aimOverride) { this.aimPoint.set(this.aimOverride.x, 1.2, this.aimOverride.z); return; }
    const m = this.input.mouse, ndc = new THREE.Vector2((m.x / innerWidth) * 2 - 1, -(m.y / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.renderer.camera);
    this.raycaster.ray.intersectPlane(this.aimPlane, this.aimPoint);
  }

  step(dt) {
    const pl = this.player, input = this.input;
    if (this.combat) dt *= this.combat.timeScale(dt); // kill hit-stop
    worldUniforms.uTime.value += dt;
    if (input.hit('Escape')) this.setPaused(this.mode === 'playing');
    if (input.hit('Tab') || input.hit('KeyI')) { if (this.mode === 'playing') this.hud.toggleInventory(); }
    const sim = this.mode === 'playing' || this.mode === 'dead' || this.mode === 'extracted';
    this.updateAim();
    if (sim && !this.hud.inventoryOpen) {
      if (this.mode === 'playing') this.runTime += dt;
      pl.update(dt, input, this.aimPoint);
      this.flowT -= dt;
      if (this.flowT <= 0) { this.flowT = 0.25; this.nav.computeFlow(pl.pos.x, pl.pos.z, 80); }
      this.enemies.update(dt);
      this.combat.update(dt);
      this.loot.update(dt, input);
      this.updateExtraction(dt);
      if (this.deathT > 0) { this.deathT -= dt; if (this.deathT <= 0 && this.player.dead && this.mode === 'playing') { this.mode = 'dead'; this.hud.showDeath(); this.hud.setScreen('dead'); } }
    } else if (this.mode === 'title') {
      // slow cinematic drift around spawn
      this.titleT = (this.titleT || 0) + dt;
    }
    const focus = new THREE.Vector3(pl.pos.x, 0, pl.pos.z);
    this.lighting.update(dt, focus);
    this.env.vol.update();
    this.fx.update(dt, focus, this.renderer.camera);
    if (this.mode === 'title') {
      const t = this.titleT || 0; this.renderer.rig.yaw = Math.PI / 4 + Math.sin(t * 0.05) * 0.4; this.renderer.rig.dist = 30;
      this.renderer.updateCamera(dt, focus, focus);
    } else {
      this.renderer.rig.yaw = Math.PI / 4; this.renderer.rig.dist = 22 * (this.zoom || 1);
      this.renderer.updateCamera(dt, focus, this.aimPoint);
    }
    cutUniforms.uCutPos.value.set(pl.pos.x, 1.2, pl.pos.z);
    this.audio.setListener(pl.pos.x, pl.pos.z);
    let nf = Infinity; for (const f of this.fx.fires) nf = Math.min(nf, Math.hypot(f.x - pl.pos.x, f.z - pl.pos.z));
    this.audio.update(dt, nf);
    if (this.mode !== 'title') this.hud.update(dt);
    // grading feedback
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.5);
    const low = pl.hp / pl.maxHp < 0.35 ? (0.35 - pl.hp / pl.maxHp) * 2 * (0.75 + 0.25 * Math.sin(performance.now() / 180)) : 0;
    this.renderer.grade.uniforms.uDamage.value = Math.min(1, Math.max(this.hurtFlash, low));
    this.renderer.grade.uniforms.uFade.value = damp(this.renderer.grade.uniforms.uFade.value, this.mode === 'dead' ? 0.35 : 0, 3, dt);
    input.endFrame();
  }

  updateExtraction(dt) {
    const ex = this.extraction, pl = this.player; if (!ex) return;
    this.exRing.material.opacity = 0.5 + Math.sin(performance.now() / 250) * 0.3;
    if (this.mode !== 'playing' || pl.dead) return;
    const inside = Math.hypot(pl.pos.x - ex.x, pl.pos.z - ex.z) < 4.2;
    if (inside) {
      if (this.extractT === 0) { this.audio.play('beep', null, { f: 660 }); if (!this.waveSpawned) this.hud.toast('Evac called — hostiles converging, hold the zone!', '#ff6a50'); this.waveSpawned = true; }
      const prev = this.extractT;
      this.extractT += dt;
      // escalating waves while holding the zone
      this.waveT = (this.waveT ?? 1) - dt;
      if (this.waveT <= 0) { this.waveT = 4.2; this.spawnEvacWave(3 + Math.floor(this.extractT / 4)); }
      if (Math.floor(prev) !== Math.floor(this.extractT)) this.audio.play('beep', null, { f: 880 });
      if (this.extractT >= this.extractDur) {
        this.mode = 'extracted'; this.audio.play('extracted');
        this.hud.showWin(); this.hud.setScreen('extracted');
      }
    } else this.extractT = Math.max(0, this.extractT - dt * 2);
  }
  // Horde waves while holding the zone: packs pour in from one or two directions at once.
  spawnEvacWave(n) {
    const ex = this.extraction, rng = this.waveRng || (this.waveRng = new RNG(this.seed ^ 0x3a3a));
    const alive = this.enemies.alive.filter((e) => e.group === 'wave').length;
    n = Math.min(n, 18 - alive); if (n <= 0) return;
    const dirs = [rng.range(0, 6.28)]; if (this.extractT > 6) dirs.push(dirs[0] + rng.range(1.6, 4.6));
    for (let i = 0; i < n; i++) {
      const a = dirs[i % dirs.length] + rng.range(-0.45, 0.45), r = rng.range(17, 26);
      const p = this.nav.nearestWalkable(ex.x + Math.cos(a) * r, ex.z + Math.sin(a) * r, 6);
      if (!p || !this.nav.isReachable(p.x, p.z)) continue;
      const type = rng.weighted([['mutant', 7], ['raider', 3], ['brute', this.extractT > 9 && i === 0 ? 3 : 0]]);
      const e = this.enemies.spawn(type, p.x, p.z, 'wave'); if (e) this.enemies.alertE(e, this.player.pos.x, this.player.pos.z, false);
    }
    if (this.hud && this.extractT > 1) this.audio.play('scream', { x: ex.x + Math.cos(dirs[0]) * 15, z: ex.z + Math.sin(dirs[0]) * 15 }, { pitch: 0.8 });
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    const rdt = Math.max(0, Math.min(0.1, (now - this.last) / 1000)); this.last = Math.max(this.last, now); // rAF time can precede performance.now() at boot
    this.fps = this.fps * 0.95 + (1 / Math.max(1e-3, rdt)) * 0.05;
    if (this.manual) return; // debug: frames driven by __game
    const dt = Math.min(rdt, 1 / 20);
    if (this.mode !== 'paused') this.step(dt); else this.input.endFrame();
    this.renderer.renderer.info.reset();
    this.renderer.render(dt);
  }
}
