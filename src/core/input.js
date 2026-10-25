// Keyboard + mouse state. `pressed` sets are cleared every frame by endFrame().
export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.pressed = new Set();
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false, rdown: false, clicked: false };
    this.wheel = 0;
    this.enabled = true;
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k); this.pressed.add(k);
      if (['Space', 'Tab', 'KeyE', 'KeyR', 'KeyQ', 'KeyF'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; this.mouse.rdown = false; });
    dom.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouse.down = true; this.mouse.clicked = true; }
      if (e.button === 2) this.mouse.rdown = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
      if (e.button === 2) this.mouse.rdown = false;
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }
  down(code) { return this.enabled && this.keys.has(code); }
  hit(code) { return this.enabled && this.pressed.has(code); }
  endFrame() { this.pressed.clear(); this.mouse.clicked = false; this.wheel = 0; }
  // Simulated input for automation / debug API.
  simKey(code, isDown) { if (isDown) { this.keys.add(code); this.pressed.add(code); } else this.keys.delete(code); }
}
