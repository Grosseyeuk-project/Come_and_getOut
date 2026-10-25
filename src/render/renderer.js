// Renderer, isometric camera rig and post-processing stack.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { setAnisotropy } from './textures.js';
import { damp, vnoise } from '../core/rng.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.9 }, uGrain: { value: 0.05 },
    uSat: { value: 0.82 }, uContrast: { value: 1.12 }, uTint: { value: new THREE.Color(1.0, 0.97, 0.92) },
    uShadowTint: { value: new THREE.Color(0.86, 0.95, 1.08) }, uDamage: { value: 0 }, uChroma: { value: 0.0015 },
    uFade: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uVignette, uGrain, uSat, uContrast, uDamage, uChroma, uFade;
    uniform vec3 uTint, uShadowTint; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; float r2 = dot(c,c);
      vec2 off = c * (uChroma + uDamage * 0.004) * (1.0 + r2 * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float l = dot(col, vec3(0.299,0.587,0.114));
      col = mix(vec3(l), col, uSat);
      col = (col - 0.5) * uContrast + 0.5;
      // split toning: cool shadows, warm highlights
      col *= mix(uShadowTint, uTint, smoothstep(0.0, 0.6, l));
      float vig = 1.0 - smoothstep(0.2, 0.85, length(c * vec2(1.0, 0.85)) * uVignette * 1.25);
      col *= mix(0.35, 1.0, vig);
      // damage: red pulsing edge
      float edge = smoothstep(0.25, 0.75, length(c) * 1.4);
      col = mix(col, vec3(0.45, 0.02, 0.02), edge * uDamage * 0.8);
      col += (h(vUv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain;
      col = mix(col, vec3(0.0), uFade);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

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
    r.setPixelRatio(Math.min(devicePixelRatio, this.quality === 'high' ? 1.5 : 1));
    r.setSize(innerWidth, innerHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = this.quality === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
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
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(scene, this.camera));
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
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
    this.grade.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }
}
