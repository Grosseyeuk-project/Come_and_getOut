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
