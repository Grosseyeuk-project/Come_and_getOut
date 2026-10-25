// CPU-simulated, GPU-rendered point-sprite particle system (one draw call per system).
import * as THREE from 'three';

const VS = `
  attribute vec4 pcolor; attribute float psize; attribute float prot;
  varying vec4 vColor; varying float vRot;
  uniform float uScale;
  #include <fog_pars_vertex>
  void main(){
    vColor = pcolor; vRot = prot;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * uScale / max(0.1, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FS = `
  uniform sampler2D map; varying vec4 vColor; varying float vRot;
  #include <fog_pars_fragment>
  void main(){
    vec2 c = gl_PointCoord - 0.5; float s = sin(vRot), co = cos(vRot);
    vec2 uv = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
    vec4 t = texture2D(map, uv);
    gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
    if (gl_FragColor.a < 0.003) discard;
    #include <fog_fragment>
  }`;

export class ParticleSystem {
  constructor(scene, { max = 2000, map, additive = false, fogMul = 1 } = {}) {
    this.max = max; this.n = 0;
    const g = this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max); this.rot = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('prot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: map }, uScale: { value: 400 } }]),
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mat.uniforms.map.value = map;
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
    // sim state
    this.p = []; // particle objects
  }
  emit(o) {
    if (this.p.length >= this.max) this.p.shift();
    const q = { x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, life: o.life || 1, t: 0,
      s0: o.s0 ?? 0.3, s1: o.s1 ?? o.s0 ?? 0.3, c0: o.c0 || [1, 1, 1, 1], c1: o.c1 || o.c0 || [1, 1, 1, 0],
      drag: o.drag || 0, grav: o.grav || 0, rot: o.rot ?? Math.random() * 6.28, rotV: o.rotV || 0, bounce: o.bounce || 0, floor: o.floor ?? 0, fadeIn: o.fadeIn || 0, arc: o.arc || 0 };
    this.p.push(q); return q;
  }
  update(dt, scale) {
    this.mat.uniforms.uScale.value = scale;
    const P = this.p; let w = 0;
    for (let i = 0; i < P.length; i++) {
      const q = P[i]; q.t += dt; if (q.t >= q.life) continue;
      const k = Math.exp(-q.drag * dt);
      q.vx *= k; q.vy = q.vy * k - q.grav * dt; q.vz *= k;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < q.floor) { if (q.bounce) { q.y = q.floor; q.vy = -q.vy * q.bounce; q.vx *= 0.6; q.vz *= 0.6; } else q.y = q.floor; }
      q.rot += q.rotV * dt;
      P[w++] = q;
    }
    P.length = w;
    const n = Math.min(w, this.max);
    for (let i = 0; i < n; i++) {
      const q = P[i], f = q.t / q.life;
      this.pos[i * 3] = q.x; this.pos[i * 3 + 1] = q.y; this.pos[i * 3 + 2] = q.z;
      const a = q.fadeIn ? Math.min(1, q.t / q.fadeIn) : 1;
      for (let c = 0; c < 4; c++) this.col[i * 4 + c] = q.c0[c] + (q.c1[c] - q.c0[c]) * f;
      this.col[i * 4 + 3] *= a;
      if (q.arc) this.col[i * 4 + 3] = Math.sin(f * Math.PI) * q.arc;
      this.size[i] = q.s0 + (q.s1 - q.s0) * f; this.rot[i] = q.rot;
    }
    this.geo.setDrawRange(0, n);
    for (const k of ['position', 'pcolor', 'psize', 'prot']) this.geo.attributes[k].needsUpdate = true;
  }
  clear() { this.p.length = 0; }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.parent && this.points.parent.remove(this.points); }
}

// ---------------------------------------------------------------------------------------------
// Velocity-stretched spark streaks: one instanced quad per spark, oriented along its screen-space
// motion (head = current position, tail = position - velocity * trail). Additive, HDR colours.
const SVS = `
  attribute vec3 head; attribute vec3 tail; attribute vec4 scolor; attribute float swidth;
  varying vec4 vColor; varying vec2 vUv;
  void main(){
    vec4 h = modelViewMatrix * vec4(head, 1.0); vec4 t = modelViewMatrix * vec4(tail, 1.0);
    vec2 d = h.xy - t.xy; float l = length(d);
    d = l > 1e-5 ? d / l : vec2(1.0, 0.0);
    vec2 n = vec2(-d.y, d.x);
    vec4 p = mix(t, h, position.x);
    p.xy += n * position.y * swidth + d * (position.x * 2.0 - 1.0) * swidth * 0.7;
    vUv = position.xy; vColor = scolor;
    gl_Position = projectionMatrix * p;
  }`;
const SFS = `
  varying vec4 vColor; varying vec2 vUv;
  void main(){
    float a = (1.0 - vUv.y * vUv.y) * (0.25 + 0.75 * vUv.x);
    gl_FragColor = vec4(vColor.rgb * a, vColor.a * a);
  }`;
export class StreakSystem {
  constructor(scene, max = 1500) {
    this.max = max; this.p = [];
    const g = this.geo = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.head = new Float32Array(max * 3); this.tail = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.w = new Float32Array(max);
    const ia = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('head', ia(this.head, 3)); g.setAttribute('tail', ia(this.tail, 3)); g.setAttribute('scolor', ia(this.col, 4)); g.setAttribute('swidth', ia(this.w, 1));
    g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({ vertexShader: SVS, fragmentShader: SFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }
  emit(o) {
    if (this.p.length >= this.max) this.p.shift();
    this.p.push({ x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, life: o.life || 0.3, t: 0, trail: o.trail ?? 0.03,
      w: o.w ?? 0.02, c0: o.c0 || [4, 2.5, 1, 1], c1: o.c1 || [1, 0.2, 0, 0], grav: o.grav ?? 9, drag: o.drag ?? 1, bounce: o.bounce ?? 0.4, floor: o.floor ?? 0.02 });
  }
  update(dt) {
    const P = this.p; let w = 0;
    for (let i = 0; i < P.length; i++) {
      const q = P[i]; q.t += dt; if (q.t >= q.life) continue;
      const k = Math.exp(-q.drag * dt);
      q.vx *= k; q.vz *= k; q.vy = q.vy * k - q.grav * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < q.floor) { q.y = q.floor; q.vy = Math.abs(q.vy) * q.bounce; q.vx *= 0.7; q.vz *= 0.7; }
      P[w++] = q;
    }
    P.length = w;
    for (let i = 0; i < w; i++) {
      const q = P[i], f = q.t / q.life, tr = q.trail;
      this.head[i * 3] = q.x; this.head[i * 3 + 1] = q.y; this.head[i * 3 + 2] = q.z;
      this.tail[i * 3] = q.x - q.vx * tr; this.tail[i * 3 + 1] = q.y - q.vy * tr; this.tail[i * 3 + 2] = q.z - q.vz * tr;
      for (let c = 0; c < 4; c++) this.col[i * 4 + c] = q.c0[c] + (q.c1[c] - q.c0[c]) * f;
      this.w[i] = q.w * (1 - f * 0.5);
    }
    this.geo.instanceCount = w;
    for (const k of ['head', 'tail', 'scolor', 'swidth']) this.geo.attributes[k].needsUpdate = true;
  }
  clear() { this.p.length = 0; this.geo.instanceCount = 0; }
  dispose() { this.geo.dispose(); this.mat.dispose(); this.mesh.parent && this.mesh.parent.remove(this.mesh); }
}

// ---------------------------------------------------------------------------------------------
// Rigid little 3D bits (shell casings, concrete chunks, gibs, scrap): instanced meshes with
// gravity, bounce, tumbling and settling; they rest on the ground for a while then shrink away.
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
export class DebrisSystem {
  constructor(scene, geo, mat, max = 300, { shadow = false } = {}) {
    this.max = max; this.p = [];
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.set(1, 1, 1));
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.castShadow = shadow; this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }
  emit(o) {
    if (this.p.length >= this.max) this.p.shift();
    const q = { x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
      wx: (Math.random() - 0.5) * (o.spin ?? 20), wy: (Math.random() - 0.5) * (o.spin ?? 20), wz: (Math.random() - 0.5) * (o.spin ?? 20),
      s: o.s ?? 1, sx: o.sx ?? 1, sy: o.sy ?? 1, sz: o.sz ?? 1, life: o.life ?? 4, t: 0, grav: o.grav ?? 16, bounce: o.bounce ?? 0.35, floor: o.floor ?? 0.02,
      color: o.color ?? 0xffffff, rest: false, onLand: o.onLand || null, landed: 0 };
    this.p.push(q); return q;
  }
  update(dt) {
    const P = this.p; let w = 0;
    for (let i = 0; i < P.length; i++) {
      const q = P[i]; q.t += dt; if (q.t >= q.life) continue;
      if (!q.rest) {
        q.vy -= q.grav * dt;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        q.rx += q.wx * dt; q.ry += q.wy * dt; q.rz += q.wz * dt;
        if (q.y < q.floor) {
          q.y = q.floor;
          if (q.onLand && q.landed === 0) q.onLand(q);
          q.landed++;
          if (Math.abs(q.vy) < 1.2) { q.rest = true; q.rx = Math.round(q.rx / Math.PI) * Math.PI; q.rz = Math.PI / 2 * Math.round(q.rz / (Math.PI / 2)); }
          q.vy = -q.vy * q.bounce; q.vx *= 0.55; q.vz *= 0.55; q.wx *= 0.5; q.wy *= 0.6; q.wz *= 0.5;
        }
      }
      P[w++] = q;
    }
    P.length = w;
    const mesh = this.mesh;
    for (let i = 0; i < w; i++) {
      const q = P[i], fade = Math.min(1, (q.life - q.t) / 0.6), s = q.s * fade;
      _p.set(q.x, q.y, q.z); _q.setFromEuler(_e.set(q.rx, q.ry, q.rz)); _s.set(s * q.sx, s * q.sy, s * q.sz);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      mesh.setColorAt(i, _c.set(q.color));
    }
    mesh.count = w; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  clear() { this.p.length = 0; this.mesh.count = 0; }
  dispose() { this.mesh.dispose(); this.mesh.parent && this.mesh.parent.remove(this.mesh); }
}
