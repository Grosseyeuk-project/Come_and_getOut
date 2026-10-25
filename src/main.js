import { Game } from './game.js';
import { installDebug } from './debug.js';

const container = document.getElementById('app');
// let the loading overlay paint before the (synchronous) world generation
requestAnimationFrame(() => setTimeout(boot, 0));
function boot() {
try {
  const game = new Game(container);
  installDebug(game);
  document.getElementById('loading').style.display = 'none';
} catch (e) {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66;padding:20px;position:fixed;inset:0;z-index:99">${String(e.stack || e)}</pre>`);
}
}
