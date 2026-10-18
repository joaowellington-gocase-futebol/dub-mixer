import './styles.css';
import { Engine } from './audio/engine.js';
import { App } from './ui/app.js';

function splash() {
  const s = document.createElement('div');
  s.className = 'splash';
  s.innerHTML = `
    <div class="splash-inner">
      <div class="logo"><span class="logo-main">DUB</span><span class="logo-dash">-</span><span class="logo-main">MIXER</span></div>
      <div class="stripe"></div>
      <button class="power" type="button">POWER</button>
      <p>Mesa de dub / reggae / sound system. Carregue suas músicas nos decks (ou use os riddims demo),
      separe voz, bateria e baixo em tempo real, jogue no tape echo e na mola, solte a sirene — e grave o seu dub.</p>
      <p class="err" style="color:#ff8c78;display:none"></p>
    </div>`;
  document.body.appendChild(s);
  return s;
}

async function boot() {
  const s = splash();
  const btn = s.querySelector('.power');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const engine = new Engine();
      await engine.init(4);
      await engine.resume();
      window.dub = { engine, app: new App(document.getElementById('app'), engine) };
      const tb = document.querySelector('.topbar');
      const setH = () => document.documentElement.style.setProperty('--topbar-h', `${tb.offsetHeight}px`);
      setH();
      new ResizeObserver(setH).observe(tb);
      s.remove();
    } catch (e) {
      console.error(e);
      const p = s.querySelector('.err');
      p.style.display = 'block';
      p.textContent = `Falha ao iniciar o áudio: ${e.message || e}`;
      btn.disabled = false;
      btn.textContent = 'POWER';
    }
  }, { once: false });
}

window.addEventListener('beforeunload', (e) => {
  if (window.dubNative) return; // Electron asks in the main process instead
  const app = window.dub && window.dub.app;
  if (app && app.takes.some((t) => !t.exported)) { e.preventDefault(); e.returnValue = ''; }
});

boot();
