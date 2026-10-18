// "VOZ COM IA" control in the deck's SEPARAR row: runs the htdemucs separation for the deck's track,
// shows progress (with cancel) and switches the deck between AI stems and the real-time DSP split.
// Only shown where AI separation exists (desktop app, or the dev server).
import { aiInfo } from '../audio/ai.js';
import { toast } from './toast.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const STAGE = {
  queued: 'na fila…',
  download: 'baixando IA…',
  prepare: 'preparando…',
  load: 'carregando IA…',
  separate: 'separando…',
  write: 'finalizando…',
};

export function mountAiStems(parent, deck, engine) {
  const row = document.createElement('div');
  row.className = 'ai-row';
  row.hidden = true;
  parent.appendChild(row);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.tabIndex = -1;
  btn.className = 'btn sm ai-btn c-gold';
  btn.innerHTML = '<span class="led"></span><span class="btn-label"></span>';
  const label = btn.querySelector('.btn-label');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  row.appendChild(btn);

  const bar = document.createElement('div');
  bar.className = 'ai-progress';
  bar.innerHTML = '<div class="ai-fill"></div><span class="ai-text"></span>';
  row.appendChild(bar);
  const fill = bar.querySelector('.ai-fill');
  const text = bar.querySelector('.ai-text');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.tabIndex = -1;
  cancel.className = 'btn sm ai-cancel';
  cancel.textContent = '✕ cancelar';
  cancel.title = 'Cancelar a separação';
  row.appendChild(cancel);

  const render = () => {
    const job = deck.aiJob;
    row.classList.toggle('running', !!job);
    btn.disabled = !deck.buffer;
    btn.classList.toggle('on', deck.aiOn);
    btn.classList.toggle('ready', !!deck.ai && !deck.aiOn);
    label.textContent = deck.ai ? 'MODO IA' : 'VOZ COM IA';
    btn.title = !deck.buffer ? 'Carregue uma música no deck'
      : deck.aiOn ? 'Separação por IA ligada (clique para voltar ao modo normal, em tempo real)'
        : deck.ai ? 'Separação por IA pronta (clique para usar)'
          : 'Separa voz, bateria, baixo e resto com inteligência artificial (Demucs): tira a voz bem mais limpo que o modo normal. Leva 1 a 3 minutos por música; depois TUDO / SEM VOZ / SÓ VOZ / SÓ BATIDA usam o resultado.';
    if (job) {
      const pct = Math.round(job.p * 100);
      fill.style.width = `${job.stage === 'queued' ? 0 : pct}%`;
      text.textContent = job.stage === 'queued' ? STAGE.queued : `${STAGE[job.stage] || 'IA…'} ${pct}%`;
    }
  };

  btn.addEventListener('click', async () => {
    if (!deck.buffer || deck.aiJob) return;
    if (deck.ai) { deck.setAiMode(!deck.aiOn); return; }
    const info = await aiInfo(true);
    if (!info.available) { toast('Separação por IA não disponível neste computador', 'warn', 4000); return; }
    if (!info.modelReady) toast('Baixando o modelo de IA (166 MB, só na primeira vez)…', 'info', 5000);
    deck.runAi();
  });
  cancel.addEventListener('click', () => deck.cancelAi());

  engine.on((type, d) => {
    if (type === 'deck-ai-error' && d.deck === deck) {
      toast(`Deck ${LETTERS[deck.index]}: separação por IA falhou (${d.error.message})`, 'err', 6000);
      return;
    }
    if (d !== deck) return;
    if (type === 'deck-ai-done') toast(`Deck ${LETTERS[deck.index]}: separação por IA pronta`);
    if (type === 'deck-ai' || type === 'deck-ai-done' || type === 'deck-load') render();
  });

  aiInfo().then((info) => { row.hidden = !info.available; render(); });
  render();
  return row;
}
