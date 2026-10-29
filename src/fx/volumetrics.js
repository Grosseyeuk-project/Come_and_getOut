// Fake volumetric light cones + glow halos for lamps / flood lights. Additive, view-angle faded,
// intensity follows the flicker level of the linked light source.
import * as THREE from 'three';
import * as T from '../render/textures.js';

const VS = `varying vec3 vN; varying vec3 vV; varying float vH;
  void main(){ vH = uv.y; vec4 wp = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp; }`;
const FS = `uniform vec3 uColor; uniform float uI; varying vec3 vN; varying vec3 vV; varying float vH;
  void main(){ float f = pow(abs(dot(normalize(vN), normalize(vV))), 1.6); float h = pow(vH, 1.4);
  gl_FragColor = vec4(uColor * uI * f * h * 0.16, 1.0); }`;

export class Volumetrics {
  constructor(scene) {
    this.scene = scene; this.items = [];
    this.geo = new THREE.CylinderGeometry(0.12, 2.6, 6, 20, 1, true); this.geo.translate(0, -3, 0);
    this.glowTex = T.softSprite('glow', 1, 0);
  }
  add(pos, color, source, len = 6, radius = 2.6) {
    if (source && source.color) color = source.color.getHex(); // lighting hook: follow the palette lamp colour
    const mat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uI: { value: 1 } }, vertexShader: VS, fragmentShader: FS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const m = new THREE.Mesh(this.geo, mat);
    m.position.copy(pos); m.scale.set(radius / 2.6, len / 6, radius / 2.6); m.renderOrder = 7;
    const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: new THREE.Color(color).multiplyScalar(1.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    g.position.copy(pos); g.scale.setScalar(1.25); g.renderOrder = 7;
    this.scene.add(m); this.scene.add(g);
    this.items.push({ m, g, source, base: 1 });
  }
  update() {
    for (const it of this.items) {
      const lv = it.source ? (it.source.level ?? 1) : 1;
      it.m.material.uniforms.uI.value = lv; it.g.material.opacity = Math.min(1, lv);
    }
  }
  dispose() { for (const it of this.items) { this.scene.remove(it.m); this.scene.remove(it.g); it.m.material.dispose(); it.g.material.dispose(); } this.items = []; }
}
