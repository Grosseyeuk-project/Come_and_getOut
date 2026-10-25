// Renderer, isometric camera rig and post-processing stack.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { setAnisotropy } from './textures.js';
import { ScatterShader, FinalShader, MAX_SCATTER } from './post.js';
import { installAtmosphere } from './atmosphere.js';
import { damp, vnoise } from '../core/rng.js';

export function detectQuality(renderer) {
  const q = new URLSearchParams(location.search).get('q');
  if (q) return q;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  if (/swiftshader|llvmpipe|software/i.test(name)) return 'low';
  return 'high';
}

export class Renderer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    const r = this.renderer;
    this.quality = detectQuality(r);
    installAtmosphere(this.quality); // global shader-chunk patches: must precede any material compile
    r.setPixelRatio(Math.min(devicePixelRatio, this.quality === 'high' ? 1.5 : 1));
    r.setSize(innerWidth, innerHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = this.quality === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NoToneMapping; // tonemapping + grade happen in FinalShader (HDR linear until then)
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.info.autoReset = false; // composer renders several passes; we reset once per frame for honest stats
    container.appendChild(r.domElement);
    setAnisotropy(Math.min(8, r.capabilities.getMaxAnisotropy()));

    this.camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 1, 220);
    this.rig = { target: new THREE.Vector3(), look: new THREE.Vector3(), yaw: Math.PI / 4, pitch: THREE.MathUtils.degToRad(56), dist: 22, trauma: 0, kick: new THREE.Vector3(), t: 0 };
    addEventListener('resize', () => this.resize());
  }

  setupPost(scene) {
    this.scene = scene;
    const r = this.renderer, w = innerWidth, h = innerHeight;
    // scene target carries a depth texture so the scatter pass can integrate light along each view ray
    const rt = new THREE.WebGLRenderTarget(w * r.getPixelRatio(), h * r.getPixelRatio(), { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w, h) });
    this.composer = new EffectComposer(r, rt);
    this.composer.setPixelRatio(r.getPixelRatio());
    // clone() shares the depth texture's Source (= same GL texture) -> feedback loop; give rt2 its own
    this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(w, h);
    this.composer.addPass(new RenderPass(scene, this.camera));
    // NaN/Inf guard + HDR clamp + in-scatter, before AO/bloom: one bad pixel would otherwise poison the bloom
    // mips and black out the whole frame (muzzle flash / impact stacks).
    const sp = this.scatter = new ShaderPass(ScatterShader), cam = this.camera, tmp = new THREE.Vector3();
    const base = sp.render.bind(sp);
    sp.render = (renderer, writeBuffer, readBuffer, dt, mask) => {
      const u = sp.uniforms, sc = this.composer.passes[0].scene, lights = sc && sc.userData.scatterLights;
      u.tDepth.value = readBuffer.depthTexture; u.uProjInv.value.copy(cam.projectionMatrixInverse);
      let n = 0;
      if (lights && this.quality !== 'low') for (const l of lights) {
        if (n >= MAX_SCATTER || !(l.intensity > 0.01)) continue;
        tmp.copy(l.position).applyMatrix4(cam.matrixWorldInverse);
        u.uL.value[n].set(tmp.x, tmp.y, tmp.z, l.distance || 20);
        u.uLC.value[n].set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity); n++;
      }
      u.uN.value = n; u.uK.value = (sc && sc.userData.grade && sc.userData.grade.scatter) || 0;
      base(renderer, writeBuffer, readBuffer, dt, mask);
    };
    this.composer.addPass(sp);
    if (this.quality === 'high') {
      try {
        this.ao = new GTAOPass(scene, this.camera, w, h);
        this.ao.output = GTAOPass.OUTPUT.Default;
        this.ao.blendIntensity = 0.85;
        this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.5, scale: 1.2, samples: 12 });
        // keep transparent / additive / alpha-tested / sprite objects out of the AO normal+depth pass
        const ao = this.ao;
        ao.overrideVisibility = function () {
          const cache = this._visibilityCache;
          this.scene.traverse((o) => {
            cache.set(o, o.visible);
            const m = o.material;
            if (o.isPoints || o.isLine || o.isSprite || (m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0 || m.blending === THREE.AdditiveBlending))) o.visible = false;
          });
        };
        this.composer.addPass(this.ao);
      } catch (e) { console.warn('GTAO disabled', e); }
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.6, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(FinalShader);
    this.composer.addPass(this.grade);
    if (this.quality !== 'low') { this.smaa = new SMAAPass(w * r.getPixelRatio(), h * r.getPixelRatio()); this.composer.addPass(this.smaa); }
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer) {
      this.composer.setSize(w, h);
      this.grade.uniforms.uRes.value.set(w, h);
    }
  }

  addTrauma(a) { this.rig.trauma = Math.min(1, this.rig.trauma + a); }
  kick(dx, dz, amt) { this.rig.kick.x -= dx * amt; this.rig.kick.z -= dz * amt; }

  // follow: world pos to frame, aim: world point for look-ahead
  updateCamera(dt, follow, aim, snap = false) {
    const rig = this.rig; rig.t += dt;
    const ahead = new THREE.Vector3().subVectors(aim, follow); ahead.y = 0;
    const al = ahead.length(); if (al > 0) ahead.multiplyScalar(Math.min(al, 14) / al * 0.22);
    const goal = new THREE.Vector3().copy(follow).add(ahead);
    if (snap) rig.look.copy(goal);
    else { rig.look.x = damp(rig.look.x, goal.x, 6, dt); rig.look.z = damp(rig.look.z, goal.z, 6, dt); rig.look.y = damp(rig.look.y, goal.y, 6, dt); }
    rig.kick.multiplyScalar(Math.exp(-14 * dt));
    rig.trauma = Math.max(0, rig.trauma - dt * 1.6);
    const sh = rig.trauma * rig.trauma;
    const sx = (vnoise(rig.t * 25, 1.3) - 0.5) * 2 * sh * 0.7, sz = (vnoise(1.7, rig.t * 25) - 0.5) * 2 * sh * 0.7, sr = (vnoise(rig.t * 20, 9.1) - 0.5) * sh * 0.03;
    const cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
    const off = new THREE.Vector3(Math.sin(rig.yaw) * cp, sp, Math.cos(rig.yaw) * cp).multiplyScalar(rig.dist);
    const look = new THREE.Vector3(rig.look.x + rig.kick.x + sx, rig.look.y, rig.look.z + rig.kick.z + sz);
    this.camera.position.copy(look).add(off);
    this.camera.lookAt(look);
    this.camera.rotateZ(sr);
  }

  render(dt) {
    const gu = this.grade.uniforms;
    gu.uTime.value += dt;
    const sc = this.composer.passes[0].scene, gp = sc && sc.userData.grade;
    if (gp && this._gradeFor !== gp) { // palette grade (set by Lighting) - applied once per world
      this._gradeFor = gp;
      gu.uExposure.value = gp.exposure; gu.uContrast.value = gp.contrast; gu.uSat.value = gp.sat; gu.uWarmSat.value = gp.warmSat;
      gu.uTint.value.setRGB(...gp.tint); gu.uShadowTint.value.setRGB(...gp.shadowTint); gu.uLift.value.setRGB(...gp.lift);
    }
    this.composer.render(dt);
  }
}
