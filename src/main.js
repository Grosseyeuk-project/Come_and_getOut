import { Game } from './game.js';
import { installDebug } from './debug.js';

const container = document.getElementById('app');
try {
  const game = new Game(container);
  installDebug(game);
} catch (e) {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66;padding:20px;position:fixed;inset:0;z-index:99">${String(e.stack || e)}</pre>`);
}
