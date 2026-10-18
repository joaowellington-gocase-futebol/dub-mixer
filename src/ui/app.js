// DUB-MIXER user interface: decks, channel strips, siren, FX rack, master, pads.
import { Knob, Fader, HSlider, Btn, Choice, Meter, h, fmt, getState, setState, registry } from './controls.js';
import { DeckWave } from './waveform.js';
import { STEM_NAMES } from '../audio/deck.js';
import { DIVISIONS } from '../audio/engine.js';
import { SIREN_PRESETS } from '../audio/fx.js';
import { STYLE_PRESETS, loadUserPresets, saveUserPresets } from './presets.js';
import { detectBpm } from '../audio/analysis.js';
import { renderDemo } from '../audio/demo.js';
import { ExportStudio } from './exportStudio.js';
import { toast, askText } from './toast.js';
import { kvGet, kvSet } from './store.js';
import { saveFile, platformName, setDirty } from '../platform.js';
import { mountAiStems } from './aiStems.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const DECK_COLORS = ['red', 'gold', 'green', 'blue'];
const SIREN_PT = { CLASSIC: 'CLÁSSICA', RISER: 'SUBINDO', LASER: 'LASER', WARBLE: 'TREMIDA', ALARM: 'ALARME', 'DEEP SIREN': 'GRAVE', BIRD: 'PASSARINHO', SPACESHIP: 'NAVE' };
const WAVE_PT = { square: 'QUADRADA', sawtooth: 'SERRA', triangle: 'TRIÂNGULO', sine: 'SENO', sawdown: 'SERRA ↓' };

const SEP_KILLS = { FULL: '0,0,0,0', INST: '1,0,0,0', ACAP: '0,1,1,1', DUB: '1,0,0,1' };
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const STEM_PRESET_LABELS = [
  ['1,0,0,0', 'SEM VOZ'], ['0,1,1,1', 'SÓ VOZ'], ['1,0,0,1', 'SÓ BATIDA'], ['1,1,0,1', 'SÓ BAIXO'], ['1,0,1,1', 'SÓ BATERIA'],
];
const stemLabel = (kills) => {
  const k = kills.map((v) => (v ? 1 : 0)).join(',');
  const hit = STEM_PRESET_LABELS.find(([p]) => p === k);
  if (hit) return hit[1];
  return 'SEM ' + ['VOZ', 'BATERIA', 'BAIXO', 'RESTO'].filter((n, i) => kills[i]).join('+');
};
const kvLocal = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };

const fmtTime = (s) => {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const ss = s - m * 60;
  return `${String(m).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
};

export class App {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    this.decks = engine.decks;
    this.deckUI = [];
    this.stripUI = [];
    this.meters = [];
    this.takes = [];
    this.studio = new ExportStudio(engine, this);
    this.build();
    this.bindKeys();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    engine.on((type, d) => this.onEngine(type, d));
    this.applyStyle("TUBBY'S HI-FI");
    this.loadUserPads();
  }

  // ======================================================================
  build() {
    const r = this.root;
    r.innerHTML = '';
    this.buildTopbar(h('header', 'topbar', r));
    this.buildFxBar(h('div', 'fxbar', r));
    const tabs = h('nav', 'tabs', r);
    [
      ['decks', 'MÚSICAS', 'Tocar as músicas, separar voz e soltar efeitos rápidos'],
      ['mixer', 'MIXER', 'Volume, filtros, equalizador e efeitos de cada canal'],
      ['fx', 'EFEITOS', 'Sirene, eco, reverb e phaser'],
      ['pads', 'SONS', 'Sons de sound system e seus próprios samples'],
    ].forEach(([k, l, t]) => {
      const b = h('button', 'tab', tabs, l);
      b.type = 'button';
      b.title = t;
      b.dataset.tab = k;
      b.onclick = () => this.setTab(k);
    });
    const main = h('main', 'desk', r);

    const decks = h('section', 'decks', main);
    decks.dataset.tab = 'decks';
    this.decks.forEach((d) => this.buildDeck(decks, d));
    const quick = h('section', 'quick-pads panel', main);
    quick.dataset.tab = 'decks';
    this.buildQuickPads(quick);

    const consoleEl = h('section', 'console', main);
    const strips = h('div', 'strips panel', consoleEl);
    strips.dataset.tab = 'mixer';
    this.decks.forEach((d) => this.buildStrip(strips, d));
    const sirenWrap = h('div', 'siren-wrap panel', consoleEl);
    sirenWrap.dataset.tab = 'fx';
    this.buildSiren(sirenWrap);
    const rack = h('div', 'fxrack', consoleEl);
    rack.dataset.tab = 'fx';
    this.buildEcho(rack);
    this.buildSpring(rack);
    this.buildPhaser(rack);
    const master = h('div', 'master panel', consoleEl);
    master.dataset.tab = 'mixer';
    this.buildMaster(master);

    const pads = h('section', 'pads panel', main);
    pads.dataset.tab = 'pads';
    this.buildPads(pads);

    this.soundDesk = this.buildSoundDesk();
    this.setTab(kvLocal('dubmixer.tab') || 'decks');
  }

  setTab(k) {
    document.body.dataset.view = k;
    this.root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    try { localStorage.setItem('dubmixer.tab', k); } catch (e) { /* noop */ }
    // the sound knobs live next to whichever effect buttons are on screen
    if (this.soundDesk) (k === 'pads' ? this.padsDeskHost : this.quickDeskHost).appendChild(this.soundDesk);
    window.dispatchEvent(new Event('resize'));
  }

  // ---------------------------------------------------------------- quick FX (MÚSICAS tab)
  buildQuickPads(p) {
    const e = this.engine;
    const hd = h('div', 'unit-head', p);
    h('span', 'unit-name', hd, 'EFEITOS RÁPIDOS');
    h('span', 'unit-model', hd, 'clique para tocar · os de "segure" funcionam enquanto o botão estiver apertado · gire os botões para o volume e o final');
    const body = h('div', 'quick-body', p);
    const g = h('div', 'pad-grid quick', body);
    this.quickDeskHost = h('div', 'desk-host', body);
    const pad = (label, color, title, o) => new Btn(g, { label, cls: 'pad', color, title, ...o });
    pad('BUZINA', 'red', 'Air horn (tecla 1)', { onChange: () => e.playSfx('AIRHORN') });
    pad('TIRO', 'red', 'Gun shot (tecla 2)', { onChange: () => e.playSfx('GUNSHOT') });
    pad('LASER', 'gold', 'Tecla 3', { onChange: () => e.playSfx('LASER') });
    pad('SIRENE', 'red', 'Segure (tecla ESPAÇO)', { mode: 'hold', onChange: (v) => (v ? e.siren.on() : e.siren.off()) });
    pad('JOGAR NO ECO', 'gold', 'Segure: a mix toda vai para o eco (tecla T)', { mode: 'hold', onChange: (v) => e.masterEchoThrow(v) });
    pad('PANCADA NA MOLA', 'green', 'Estrondo do reverb de mola (tecla H)', { onChange: () => e.spring.crash() });
    pad('TIRAR GRAVE', 'red', 'Segure: tira o grave da mix (tecla B)', { mode: 'hold', onChange: (v) => e.bassDrop(v) });
    pad('LIMPAR ECO', 'blue', 'Corta todos os ecos (tecla ESC)', { onChange: () => e.echo.clear() });
  }

  // ---------------------------------------------------------------- sound desk: knobs for the one-shots and the siren
  buildSoundDesk() {
    const e = this.engine;
    const t = () => e.ctx.currentTime;
    const desk = h('div', 'sound-desk');
    const g1 = h('div', 'sd-group', desk);
    h('div', 'sd-title', g1, 'SONS E SAMPLES');
    const r1 = h('div', 'krow', g1);
    new Knob(r1, { id: 'sfx.vol', label: 'VOLUME', size: 's', color: 'gold', min: 0, max: 1.5, def: 0.8, format: fmt.pct,
      title: 'Volume da buzina, tiro, laser… e dos seus samples (gire antes ou durante)', onChange: (v) => e.sfxBus.gain.setTargetAtTime(v, t(), 0.02) });
    new Knob(r1, { id: 'sfx.echo', label: 'ECO', size: 's', color: 'gold', min: 0, max: 1, def: 0.6, format: fmt.pct,
      title: 'Quanto eco os sons levam (mais eco = final mais longo)', onChange: (v) => e.sfxEcho.gain.setTargetAtTime(v, t(), 0.02) });
    new Knob(r1, { id: 'sfx.rev', label: 'REVERB', size: 's', color: 'green', min: 0, max: 1, def: 0.2, format: fmt.pct,
      title: 'Quanto reverb de mola os sons levam', onChange: (v) => e.sfxRev.gain.setTargetAtTime(v, t(), 0.02) });

    const g2 = h('div', 'sd-group', desk);
    h('div', 'sd-title', g2, 'SIRENE');
    const r2 = h('div', 'krow', g2);
    this.deskMirrors = [];
    // mirrors of the siren knobs in the EFEITOS tab, kept in sync both ways
    const mirror = (src, label, color, format, title) => {
      if (!src) return;
      const k = new Knob(r2, { label, size: 's', color, min: src.min, max: src.max, def: src.def, value: src.value, persist: false, format, title, onChange: (v) => src.set(v) });
      this.deskMirrors.push([k, src]);
    };
    mirror(registry.get('siren.vol'), 'VOLUME', 'red', fmt.pct, 'Volume da sirene');
    mirror(registry.get('siren.echo'), 'ECO', 'gold', fmt.pct, 'Quanto eco a sirene leva');
    mirror(this.sirenKnobs.decay, 'FINAL', null, fmt.sec, 'Quanto tempo a sirene demora para sumir depois que você solta o botão');

    const g3 = h('div', 'sd-group sd-stop', desk);
    new Btn(g3, { label: '■ CORTAR SONS', cls: 'sm cut-sounds', color: 'red', title: 'Para na hora a sirene e todos os sons que estão tocando (e o eco deles, se nenhuma música estiver no eco)', onChange: () => this.cutSounds() });
    new Btn(g3, { label: 'LIMPAR ECO', cls: 'sm', color: 'blue', title: 'Corta o eco que ficou repetindo (tecla ESC)', onChange: () => e.echo.clear() });
    return desk;
  }

  cutSounds() {
    const e = this.engine;
    e.stopSounds();
    this.sirenLatch.set(false, false);
    this.sirenBtn.el.classList.remove('on');
    // the echo is shared: only wipe it when no deck is feeding it, so the music's echo survives
    if (!this.decks.some((d) => d.sendLevels.echo > 0.005 || d.throwing.echo) && !e.throwAllOn) e.echo.clear();
    if (!this.decks.some((d) => d.sendLevels.rev > 0.005 || d.throwing.rev)) e.spring.clear();
    this.fxT = 0;
  }

  // ---------------------------------------------------------------- active effects bar + timeline
  buildFxBar(bar) {
    h('span', 'fxbar-title', bar, 'EFEITOS LIGADOS');
    this.fxChips = h('div', 'fx-chips', bar);
    this.fxEmpty = h('span', 'fx-empty', this.fxChips, 'nenhum — tudo limpo');
    this.fxTlBtn = new Btn(bar, { label: 'LINHA DO TEMPO', mode: 'toggle', persist: false, cls: 'sm', color: 'blue',
      title: 'Mostra quando cada efeito foi ligado nos últimos 60 segundos', onChange: (v) => this.fxTl.classList.toggle('open', v) });
    new Btn(bar, { label: '■ PARAR TUDO', cls: 'sm stop-all', color: 'red', title: 'Desliga todos os efeitos e corta os ecos', onChange: () => this.stopAllFx() });
    this.fxTl = h('div', 'fx-timeline', bar);
    this.fxDefsList = this.fxDefs();
    this.fxChipEls = new Map();
    this.fxHistory = [];
    this.fxActive = [];
    this.fxT = 0;
    this.echoMeter = this.engine.ctx.createAnalyser();
    this.echoMeter.fftSize = 512;
    this.engine.echo.output.connect(this.echoMeter);
    this._echoBuf = new Float32Array(512);
  }

  // Every effect that can be left on, how to detect it, and how to switch it off.
  fxDefs() {
    const e = this.engine;
    const reg = (id) => registry.get(id);
    const setCtl = (id, v) => { const c = reg(id); if (c) c.set(v); };
    const val = (id) => { const c = reg(id); return c ? c.value : 0; };
    const defs = [];
    this.decks.forEach((d, i) => {
      const L = LETTERS[i];
      const ch = (s) => `ch${i}.${s}`;
      defs.push(
        { key: `echo${i}`, color: 'gold', label: () => `ECO no deck ${L}`, active: () => d.sendLevels.echo > 0.005 || d.throwing.echo,
          stop: () => { setCtl(ch('send.echo'), 0); d.throwSend('echo', false); } },
        { key: `rev${i}`, color: 'green', label: () => `REVERB no deck ${L}`, active: () => d.sendLevels.rev > 0.005 || d.throwing.rev,
          stop: () => { setCtl(ch('send.rev'), 0); d.throwSend('rev', false); } },
        { key: `hpf${i}`, color: 'red', label: () => `FILTRO SEM GRAVE · ${L}`, active: () => val(ch('hpf')) > 0.001, stop: () => setCtl(ch('hpf'), 0) },
        { key: `lpf${i}`, color: 'red', label: () => `FILTRO ABAFADO · ${L}`, active: () => val(ch('lpf')) > 0.001, stop: () => setCtl(ch('lpf'), 0) },
        { key: `eqk${i}`, color: 'red', label: () => `CORTE DE ${['low', 'mid', 'high'].filter((b) => d.eqKill[b]).map((b) => ({ low: 'GRAVE', mid: 'MÉDIO', high: 'AGUDO' })[b]).join('+')} · ${L}`,
          active: () => d.eqKill.low || d.eqKill.mid || d.eqKill.high,
          stop: () => ['low', 'mid', 'high'].forEach((b) => setCtl(ch(`kill.${b}`), false)) },
        { key: `stem${i}`, color: 'gold', label: () => `${stemLabel(d.stemKill)} · ${L}`,
          active: () => d.stemKill.some(Boolean) && !this._savedKills && !this._savedV, stop: () => d.stemMode('FULL') },
        { key: `loop${i}`, color: 'blue', label: () => `REPETINDO ${d.loop && d.loop.beats ? d.loop.beats + ' TEMPOS' : ''} · ${L}`, active: () => !!d.loop, stop: () => d.exitLoop() },
        { key: `mute${i}`, color: 'red', label: () => `MUDO · ${L}`, active: () => d.mute, stop: () => setCtl(ch('mute'), false) },
        { key: `solo${i}`, color: 'gold', label: () => `SOLO · ${L}`, active: () => d.solo, stop: () => setCtl(ch('solo'), false) },
      );
    });
    defs.push(
      { key: 'siren', color: 'red', label: () => 'SIRENE', active: () => e.siren.held > 0,
        stop: () => { this.sirenLatch.set(false, false); e.siren.held = 1; e.siren.off(); this.sirenBtn.el.classList.remove('on'); } },
      { key: 'sounds', color: 'red', label: () => 'SONS TOCANDO', active: () => e.soundsPlaying(), stop: () => this.cutSounds() },
      { key: 'throwAll', color: 'gold', label: () => 'MIX TODA NO ECO', active: () => !!e.throwAllOn, stop: () => e.masterEchoThrow(false) },
      { key: 'freeze', color: 'blue', label: () => 'ECO CONGELADO', active: () => e.echo.frozen, stop: () => e.echo.freeze(false) },
      { key: 'echoInf', color: 'red', label: () => 'ECO INFINITO', active: () => e.echo.params.feedback >= 1, stop: () => setCtl('echo.feedback', 0.6) },
      { key: 'echoTail', color: 'gold', label: () => 'ECO AINDA SOANDO', active: () => this._echoRinging, stop: () => e.echo.clear() },
      { key: 'bassDrop', color: 'red', label: () => 'MIX SEM GRAVE', active: () => !!e.bassDropOn, stop: () => e.bassDrop(false) },
      { key: 'dubOut', color: 'gold', label: () => 'SÓ BATIDA (TODOS)', active: () => !!this._savedKills, stop: () => this.dubOut(false) },
      { key: 'noVocal', color: 'green', label: () => 'SEM VOZ (TODOS)', active: () => !!this._savedV, stop: () => this.noVocal(false) },
      { key: 'phaser', color: 'blue', label: () => 'PHASER', active: () => !!val('phaser.on'), stop: () => setCtl('phaser.on', false) },
      { key: 'mfilter', color: 'gold', label: () => 'FILTRO GERAL', active: () => Math.abs(val('master.filter')) > 0.01, stop: () => setCtl('master.filter', 0) },
    );
    return defs;
  }

  // called from the animation loop
  tickFx(now) {
    if (now - this.fxT < 120) return;
    this.fxT = now;
    // echo tail still audible although nothing feeds the echo any more
    this.echoMeter.getFloatTimeDomainData(this._echoBuf);
    let pk = 0;
    for (let k = 0; k < this._echoBuf.length; k++) pk = Math.max(pk, Math.abs(this._echoBuf[k]));
    const feeding = this.fxDefsList.some((f) => /^(echo\d|throwAll|freeze|siren)$/.test(f.key) && f.active());
    this._echoRinging = pk > 0.006 && !feeding;

    const active = this.fxDefsList.filter((f) => { try { return f.active(); } catch (err) { return false; } });
    const keys = new Set(active.map((f) => f.key));
    // history for the timeline
    for (const seg of this.fxHistory) if (seg.end == null && !keys.has(seg.key)) seg.end = now;
    for (const f of active) {
      const open = this.fxHistory.find((sg) => sg.key === f.key && sg.end == null);
      if (open) open.label = f.label(); else this.fxHistory.push({ key: f.key, label: f.label(), color: f.color, start: now, end: null });
    }
    this.fxHistory = this.fxHistory.filter((sg) => sg.end == null || now - sg.end < 70000);
    this.fxActive = active;

    // chips
    for (const [k, el] of this.fxChipEls) if (!keys.has(k)) { el.remove(); this.fxChipEls.delete(k); }
    for (const f of active) {
      let el = this.fxChipEls.get(f.key);
      if (!el) {
        el = h('button', `fx-chip c-${f.color}`, this.fxChips);
        el.type = 'button';
        el.title = 'Clique para desligar';
        el._name = h('span', 'fx-chip-name', el);
        el._time = h('span', 'fx-chip-time', el);
        h('span', 'fx-chip-x', el, '✕');
        el.onclick = () => { f.stop(); this.fxT = 0; };
        this.fxChipEls.set(f.key, el);
      }
      const seg = this.fxHistory.find((sg) => sg.key === f.key && sg.end == null);
      const name = f.label();
      if (el._name.textContent !== name) el._name.textContent = name;
      const t = seg ? fmtClock((now - seg.start) / 1000) : '';
      if (el._time.textContent !== t) el._time.textContent = t;
    }
    this.fxEmpty.style.display = active.length ? 'none' : '';
    if (this.fxTl.classList.contains('open')) this.drawFxTimeline(now);
  }

  drawFxTimeline(now) {
    const WIN = 60000;
    const tl = this.fxTl;
    tl.innerHTML = '';
    const head = h('div', 'tl-head', tl);
    h('span', '', head, 'ÚLTIMOS 60 SEGUNDOS');
    const axis = h('div', 'tl-axis', head);
    ['-60s', '-45s', '-30s', '-15s', 'agora'].forEach((t) => h('span', '', axis, t));
    const rows = [];
    for (const sg of this.fxHistory) {
      if (sg.end != null && now - sg.end > WIN) continue;
      let r = rows.find((x) => x.key === sg.key);
      if (!r) { r = { key: sg.key, label: sg.label, color: sg.color, segs: [] }; rows.push(r); }
      r.label = sg.label;
      r.segs.push(sg);
    }
    if (!rows.length) { h('div', 'tl-empty', tl, 'Nenhum efeito usado no último minuto.'); return; }
    for (const r of rows) {
      const live = this.fxActive.find((f) => f.key === r.key);
      const row = h('div', 'tl-row', tl);
      const name = h('div', 'tl-name', row, r.label);
      name.title = r.label;
      const track = h('div', 'tl-track', row);
      for (const sg of r.segs) {
        const a = Math.max(0, (sg.start - (now - WIN)) / WIN);
        const b = Math.min(1, ((sg.end ?? now) - (now - WIN)) / WIN);
        const bar = h('div', `tl-seg c-${sg.color}${sg.end == null ? ' live' : ''}`, track);
        bar.style.left = `${a * 100}%`;
        bar.style.width = `${Math.max(0.6, (b - a) * 100)}%`;
      }
      const btn = h('button', 'tl-stop', row, live ? '✕ PARAR' : 'desligado');
      btn.type = 'button';
      btn.disabled = !live;
      if (live) btn.onclick = () => { live.stop(); this.fxT = 0; };
    }
  }

  stopAllFx() {
    for (const f of this.fxDefsList) { try { if (f.active()) f.stop(); } catch (err) { /* keep going */ } }
    this.engine.echo.clear();
    this.fxT = 0;
    toast('Todos os efeitos foram desligados', 'ok');
  }

  // ---------------------------------------------------------------- top bar
  buildTopbar(bar) {
    const logo = h('div', 'logo', bar);
    h('span', 'logo-main', logo, 'DUB');
    h('span', 'logo-dash', logo, '-');
    h('span', 'logo-main', logo, 'MIXER');

    const lib = h('div', 'tb-group', bar);
    const multi = h('input', '', bar);
    multi.type = 'file';
    multi.multiple = true;
    multi.accept = 'audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.aiff,.aif,.opus,.webm';
    multi.style.display = 'none';
    multi.onchange = () => { this.openFiles([...multi.files]); multi.value = ''; };
    this.openPicker = () => multi.click();
    new Btn(lib, { label: '＋ ABRIR MÚSICA', cls: 'open-main', color: 'gold', onChange: () => multi.click() }).el.title = 'Abrir MP3/WAV/FLAC… (vários arquivos vão para os decks livres)';
    new Btn(lib, { label: 'DEMO 1', cls: 'sm demo-btn', title: 'Carrega um riddim de exemplo (one drop)', onChange: () => this.loadDemo('onedrop') });
    new Btn(lib, { label: 'DEMO 2', cls: 'sm demo-btn', title: 'Carrega um riddim de exemplo (steppers)', onChange: () => this.loadDemo('steppers') });

    const tempo = h('div', 'tb-group', bar);
    h('label', 'tb-label', tempo, 'BPM');
    this.bpmLcd = h('div', 'lcd lcd-big bpm', tempo, '75.0');
    this.bpmLcd.title = 'Batidas por minuto da mix (o eco segue este tempo)';
    const bm = new Btn(tempo, { label: '−', cls: 'sm', onChange: () => this.engine.setBpm(Math.round((this.engine.bpm - 0.5) * 10) / 10) });
    const bp = new Btn(tempo, { label: '+', cls: 'sm', onChange: () => this.engine.setBpm(Math.round((this.engine.bpm + 0.5) * 10) / 10) });
    bm.el.title = 'BPM −0.5'; bp.el.title = 'BPM +0.5';
    new Btn(tempo, { label: 'BATER', cls: 'sm', key: 'Y', title: 'Bata no ritmo (3 vezes ou mais) para definir o BPM — tecla Y', onChange: () => this.tap() });

    const pre = h('div', 'tb-group tb-preset', bar);
    h('label', 'tb-label', pre, 'ESTILO');
    this.presetSel = h('select', 'preset-sel', pre);
    this.presetSel.title = 'Estilos prontos de mixagem (eco, reverb, sirene…)';
    this.fillPresets();
    this.presetSel.onchange = () => {
      const v = this.presetSel.value;
      if (v.startsWith('f:')) this.applyStyle(v.slice(2));
      else if (v.startsWith('u:')) this.applyUser(v.slice(2));
    };
    new Btn(pre, { label: 'SALVAR', cls: 'sm', title: 'Salvar os ajustes atuais como um estilo seu', onChange: () => this.saveUserPreset() });
    new Btn(pre, { label: 'APAGAR', cls: 'sm', title: 'Apagar o estilo seu selecionado', onChange: () => this.deleteUserPreset() });

    const rec = h('div', 'tb-group rec-group', bar);
    this.recBtn = new Btn(rec, { label: 'GRAVAR', mode: 'toggle', persist: false, color: 'red', cls: 'rec', key: 'Enter', title: 'Grava tudo o que sai da mesa (tecla ENTER)', onChange: (on) => this.toggleRec(on) });
    this.recLcd = h('div', 'lcd lcd-big rec-time', rec, '00:00.0');
    new Btn(rec, { label: 'GRAVAÇÕES', cls: 'sm', title: 'Ouvir e exportar suas gravações', onChange: () => this.studio.openTakes() });

    const sys = h('div', 'tb-group', bar);
    new Btn(sys, { label: 'AJUDA', cls: 'sm', onChange: () => this.showHelp() }).el.title = 'Como usar e atalhos de teclado';
    new Btn(sys, { label: '⛶', cls: 'sm', onChange: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    } }).el.title = 'Tela cheia';
  }

  fillPresets() {
    const sel = this.presetSel;
    const cur = sel.value;
    sel.innerHTML = '';
    const g1 = h('optgroup', '', sel); g1.label = 'ESTILOS PRONTOS';
    Object.keys(STYLE_PRESETS).forEach((k) => { const o = h('option', '', g1, k); o.value = 'f:' + k; });
    const user = loadUserPresets();
    if (Object.keys(user).length) {
      const g2 = h('optgroup', '', sel); g2.label = 'MEUS ESTILOS';
      Object.keys(user).forEach((k) => { const o = h('option', '', g2, k); o.value = 'u:' + k; });
    }
    if (cur) sel.value = cur;
  }

  applyStyle(name) {
    const p = STYLE_PRESETS[name];
    if (!p) return;
    setState(p);
    if (p['siren.preset']) this.setSirenPreset(p['siren.preset']);
    this.presetSel.value = 'f:' + name;
  }
  applyUser(name) {
    const p = loadUserPresets()[name];
    if (!p) return;
    setState(p);
    this.presetSel.value = 'u:' + name;
    toast(`Estilo "${name}" carregado`);
  }
  async saveUserPreset() {
    const name = await askText('NOME DO ESTILO', 'Meu Dub');
    if (!name) return;
    const all = loadUserPresets();
    all[name] = getState();
    if (!saveUserPresets(all)) { toast('Não foi possível salvar o estilo', 'err'); return; }
    this.fillPresets();
    this.presetSel.value = 'u:' + name;
    toast(`Estilo "${name}" salvo`);
  }
  deleteUserPreset() {
    const v = this.presetSel.value;
    if (!v.startsWith('u:')) { toast('Selecione um estilo seu para apagar', 'warn'); return; }
    const name = v.slice(2);
    if (!confirm(`Apagar o estilo "${name}"?`)) return;
    const all = loadUserPresets();
    delete all[name];
    saveUserPresets(all);
    this.fillPresets();
  }

  tap() {
    const now = performance.now();
    this.taps = (this.taps || []).filter((t) => now - t < 3000);
    this.taps.push(now);
    if (this.taps.length >= 3) {
      const iv = [];
      for (let i = 1; i < this.taps.length; i++) iv.push(this.taps[i] - this.taps[i - 1]);
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
      this.engine.setBpm(Math.round((60000 / avg) * 10) / 10);
    }
  }

  // ---------------------------------------------------------------- decks
  buildDeck(parent, deck) {
    const i = deck.index;
    const ui = {};
    const card = h('div', `deck-card deck-${DECK_COLORS[i]}`, parent);
    ui.card = card;
    const head = h('div', 'deck-head', card);
    h('div', 'deck-letter', head, LETTERS[i]);
    ui.name = h('div', 'lcd deck-name', head, '— vazio —');
    ui.bpm = h('div', 'lcd deck-bpm', head, '---.-');
    ui.bpm.title = 'BPM desta música (clique para corrigir: ×2 / ÷2 / digitar)';
    ui.bpm.onclick = () => this.bpmMenu(deck, ui.bpm);
    ui.time = h('div', 'lcd deck-time', head, '00:00.0');
    ui.remain = h('div', 'lcd deck-time remain', head, '-00:00.0');
    const file = h('input', '', card);
    file.type = 'file';
    file.accept = 'audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.aiff,.aif,.opus,.webm';
    file.style.display = 'none';
    file.onchange = () => { if (file.files[0]) this.loadFile(file.files[0], deck); file.value = ''; };
    new Btn(head, { label: 'ABRIR', cls: 'sm', color: 'gold', onChange: () => file.click() }).el.title = 'Abrir música neste deck';
    new Btn(head, { label: '⏏', cls: 'sm', onChange: () => deck.eject() }).el.title = 'Tirar a música do deck';

    const zc = h('canvas', 'wave-zoom', card);
    const oc = h('canvas', 'wave-over', card);
    ui.wave = new DeckWave(zc, oc, deck);
    zc.addEventListener('click', () => { if (!deck.buffer) file.click(); });

    const row = h('div', 'deck-row', card);
    ui.play = new Btn(row, { label: '▶', cls: 'play', color: 'green', mode: 'push', onChange: () => deck.toggle() });
    ui.play.el.title = `Tocar / pausar (tecla ${'QWER'[i]})`;
    ui.cue = new Btn(row, { label: 'MARCA', cls: 'cue', color: 'gold', title: 'Parado: marca este ponto. Tocando: volta para a marca e pausa', onChange: () => deck.cue() });
    const hc = h('div', 'btn-group', row);
    h('span', 'grp-label', hc, 'PONTOS');
    ui.hot = [0, 1, 2, 3].map((k) => {
      const b = new Btn(hc, { label: String(k + 1), cls: `hot hot${k}`, onChange: () => deck.hotCue(k) });
      b.el.title = 'Ponto de memória: 1º clique grava, depois pula para ele (clique direito/segurar: apagar)';
      const clear = (e) => { e.preventDefault(); deck.hotCue(k, true); };
      b.el.addEventListener('contextmenu', clear);
      let t;
      b.el.addEventListener('touchstart', () => { t = setTimeout(() => deck.hotCue(k, true), 650); }, { passive: true });
      b.el.addEventListener('touchend', () => clearTimeout(t));
      return b;
    });
    const lp = h('div', 'btn-group loop', row);
    h('span', 'grp-label', lp, 'REPETIR');
    ui.loops = [1, 2, 4, 8, 16].map((n) => new Btn(lp, { label: String(n), cls: 'loopbtn', title: `Repetir ${n} tempo(s) sem parar`, onChange: () => {
      if (deck.loop && deck.loop.beats === n) deck.exitLoop(); else deck.setLoopBeats(n);
    } }));
    new Btn(lp, { label: 'SAIR', cls: 'loopbtn', title: 'Parar de repetir', onChange: () => deck.exitLoop() });

    const row2 = h('div', 'deck-row', card);
    new Btn(row2, { label: 'FREAR', cls: 'fxbtn', color: 'red', onChange: () => deck.brake() }).el.title = 'Para a música como um disco freando';
    new Btn(row2, { label: 'REWIND', cls: 'fxbtn', color: 'red', onChange: () => deck.rewind() }).el.title = 'Puxa o disco para trás e volta da MARCA (pull up!)';
    ui.auto = new Btn(row2, { label: 'AUTO', mode: 'toggle', id: `deck${i}.autorestart`, value: true, cls: 'sm', onChange: (v) => { deck.autoRestart = v; } });
    ui.auto.el.title = 'Depois do REWIND, voltar a tocar sozinho';
    new Btn(row2, { label: 'SINC', cls: 'sm', onChange: () => {
      if (!deck.bpm) { toast('O BPM desta música ainda não foi detectado', 'warn'); return; }
      deck.sync();
      this.syncPitchUI(deck);
    } }).el.title = 'Ajusta a velocidade para ficar no mesmo BPM da mix';
    const pitchBox = h('div', 'pitch-box', row2);
    h('span', 'grp-label', pitchBox, 'VELOC.');
    ui.pitchRange = 0.08;
    ui.pitch = new HSlider(pitchBox, {
      id: `deck${i}.pitch`, min: -1, max: 1, def: 0, value: 0, persist: false,
      format: (v) => `${v >= 0 ? '+' : ''}${(v * ui.pitchRange * 100).toFixed(2)}%`,
      onChange: (v) => deck.setRate(1 + v * ui.pitchRange),
    });
    ui.pitch.el.title = 'Velocidade da música (duplo clique: volta ao normal)';
    ui.pitchLcd = h('div', 'lcd pitch-lcd', pitchBox, '+0.00%');
    ui.range = new Choice(pitchBox, {
      options: ['±8%', '±16%', '±50%'], value: '±8%', persist: false, cls: 'mini',
      onChange: (v) => {
        const cur = deck.rate - 1;
        ui.pitchRange = { '±8%': 0.08, '±16%': 0.16, '±50%': 0.5 }[v];
        ui.pitch.set(Math.max(-1, Math.min(1, cur / ui.pitchRange)), true);
      },
    });

    // beginner row: separate voice / beat + channel volume
    const row3 = h('div', 'deck-row sep-row', card);
    h('span', 'grp-label', row3, 'SEPARAR');
    const sep = h('div', 'btn-group seg', row3);
    ui.sep = [
      ['FULL', 'TUDO', 'Música completa'],
      ['INST', 'SEM VOZ', 'Tira a voz (fica só o instrumental)'],
      ['ACAP', 'SÓ VOZ', 'Deixa só a voz (acapella)'],
      ['DUB', 'SÓ BATIDA', 'Só bateria e baixo (drum & bass)'],
    ].map(([m, l, t]) => {
      const b = new Btn(sep, { label: l, cls: 'sm sep', color: m === 'FULL' ? 'green' : 'gold', title: t, onChange: () => deck.stemMode(m) });
      b.mode = m;
      return b;
    });
    ui.aiSlot = h('div', 'ai-slot', row3);
    mountAiStems(ui.aiSlot, deck, this.engine); // desktop: high-quality AI separation
    const vol = h('div', 'vol-box', row3);
    h('span', 'grp-label', vol, 'VOLUME');
    ui.vol = new HSlider(vol, { min: 0, max: 1, def: 0.8, value: 0.8, persist: false, cls: 'vol',
      format: (v) => (v <= 0 ? 'mudo' : `${Math.round((v / 0.8) * 100)}%`),
      onChange: (v) => { const f = registry.get(`ch${i}.fader`); if (f) f.set(v); else deck.setFader(v); } });
    ui.vol.el.title = 'Volume deste deck (o mesmo do fader no MIXER)';

    // drag & drop
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.loadFile(f, deck);
    });
    this.deckUI[i] = ui;
  }

  syncPitchUI(deck) {
    const ui = this.deckUI[deck.index];
    let v = (deck.rate - 1) / ui.pitchRange;
    if (Math.abs(v) > 1) {
      ui.range.set('±50%', false);
      ui.pitchRange = 0.5;
      v = (deck.rate - 1) / 0.5;
    }
    ui.pitch.set(v, false);
  }

  bpmMenu(deck, anchor) {
    if (!deck.bpm) return;
    const m = h('div', 'popmenu', document.body);
    const r = anchor.getBoundingClientRect();
    m.style.left = `${r.left}px`;
    m.style.top = `${r.bottom + 4}px`;
    const item = (t, fn) => { const b = h('button', '', m, t); b.type = 'button'; b.onclick = () => { fn(); m.remove(); }; };
    item('× 2', () => { deck.bpm *= 2; });
    item('÷ 2', () => { deck.bpm /= 2; });
    item('USAR COMO BPM DA MIX', () => this.engine.setBpm(Math.round(deck.effectiveBpm * 10) / 10));
    item('DIGITAR BPM…', async () => { const v = parseFloat(await askText('BPM DA FAIXA', deck.bpm.toFixed(1))); if (v > 30 && v < 300) deck.bpm = v; });
    setTimeout(() => document.addEventListener('pointerdown', function close(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close); } }), 0);
  }

  async loadFile(file, deck) {
    await this.engine.resume();
    const ui = this.deckUI[deck.index];
    ui.name.textContent = 'carregando…';
    try {
      const ab = await file.arrayBuffer();
      const buf = await this.engine.ctx.decodeAudioData(ab);
      const name = file.name.replace(/\.[^.]+$/, '');
      this.loadBuffer(deck, buf, { name });
    } catch (e) {
      console.error(e);
      ui.name.textContent = '— vazio —';
      toast(`Não consegui abrir "${file.name}". Formato não suportado ou arquivo corrompido.`, 'err', 4500);
    }
  }

  loadBuffer(deck, buf, meta) {
    deck.load(buf, meta);
    this.deckUI[deck.index].pitch.set(0);
    if (!meta.bpm) {
      detectBpm(buf).then((bpm) => {
        if (deck.buffer !== buf) return;
        deck.bpm = bpm;
        if (bpm && !this.decks.some((d) => d !== deck && d.playing)) this.engine.setBpm(bpm);
      });
    } else if (!this.decks.some((d) => d !== deck && d.playing)) {
      this.engine.setBpm(meta.bpm);
    }
    toast(`${LETTERS[deck.index]}: ${meta.name}`);
  }

  async openFiles(files) {
    if (!files.length) return;
    const free = this.decks.filter((d) => !d.buffer);
    const targets = free.length ? free : [this.decks.find((d) => !d.playing) || this.decks[0]];
    this.setTab('decks');
    for (let i = 0; i < files.length && i < targets.length; i++) await this.loadFile(files[i], targets[i]);
    if (files.length > targets.length) toast(`Só ${targets.length} deck(s) livre(s): ${files.length - targets.length} arquivo(s) ignorado(s)`, 'warn', 4000);
  }

  async loadDemo(style) {
    await this.engine.resume();
    toast('Gerando música de exemplo…');
    const { buffer, bpm, name } = await renderDemo(style, this.engine.ctx.sampleRate);
    const target = this.decks.find((d) => !d.buffer) || this.decks[0];
    this.loadBuffer(target, buffer, { name, bpm });
  }

  // ---------------------------------------------------------------- channel strip
  buildStrip(parent, deck) {
    const i = deck.index;
    const id = (s) => `ch${i}.${s}`;
    const ui = {};
    const s = h('div', `strip strip-${DECK_COLORS[i]}`, parent);
    const top = h('div', 'strip-head', s);
    h('div', 'strip-num', top, LETTERS[i]);
    ui.title = h('div', 'strip-title', top, '—');

    let row = h('div', 'krow', s);
    new Knob(row, { id: id('gain'), label: 'GANHO', size: 's', min: -24, max: 12, def: 0, bipolar: true, format: fmt.db, title: 'Volume de entrada (deixe o medidor sem ficar vermelho)', onChange: (v) => deck.setTrim(v) });
    new Knob(row, { id: id('pan'), label: 'LADO', size: 's', min: -1, max: 1, def: 0, bipolar: true, format: fmt.bip, title: 'Esquerda / direita', onChange: (v) => deck.setPan(v) });

    // stems
    const st = h('div', 'stems', s);
    h('div', 'sec-label', st, 'SEPARAR (VOZ · BATERIA · BAIXO · RESTO)');
    const grid = h('div', 'stem-grid', st);
    const stemPt = ['VOZ', 'BATERIA', 'BAIXO', 'RESTO'];
    ui.stemKill = STEM_NAMES.map((n, k) => {
      const cell = h('div', 'stem-cell', grid);
      new Knob(cell, { id: id(`stem${k}`), size: 'xs', min: 0, max: 1.5, def: 1, color: ['gold', 'red', 'green', 'blue'][k], format: fmt.pct, title: `Volume de ${stemPt[k]}`, onChange: (v) => deck.setStemGain(k, v) });
      return new Btn(cell, { id: id(`skill${k}`), mode: 'toggle', label: stemPt[k], cls: 'kill', title: `Desliga ${stemPt[k]}`, onChange: (v) => deck.setStemKill(k, v) });
    });
    const modes = h('div', 'stem-modes', st);
    [['FULL', 'TUDO', 'Música completa'], ['INST', 'SEM VOZ', 'Instrumental (tira a voz)'], ['ACAP', 'SÓ VOZ', 'Acapella (só a voz)'], ['DUB', 'BATIDA', 'Só bateria e baixo']].forEach(([m, l, t]) => {
      new Btn(modes, { label: l, cls: 'xs', title: t, onChange: () => deck.stemMode(m) });
    });

    // big knob filter + EQ side by side
    const tone = h('div', 'tone-sec', s);
    const flt = h('div', 'filter-sec', tone);
    h('div', 'sec-label', flt, 'FILTRO');
    const fr = h('div', 'krow', flt);
    new Knob(fr, { id: id('hpf'), label: 'TIRA GRAVE', size: 'm', color: 'red', min: 0, max: 1, def: 0, steps: 0,
      format: (v) => (v <= 0.001 ? 'DESL.' : fmt.hz(20 * Math.pow(200, v))), onChange: (v) => deck.setHpf(v), title: 'Filtro "big knob": gire para tirar o grave (efeito clássico de dub)' });
    const fc = h('div', 'kcol', fr);
    new Knob(fc, { id: id('lpf'), label: 'ABAFAR', size: 'xs', min: 0, max: 1, def: 0,
      format: (v) => (v <= 0.001 ? 'DESL.' : fmt.hz(22000 * Math.pow(150 / 22000, v))), title: 'Tira o agudo (som abafado)', onChange: (v) => deck.setLpf(v) });
    new Knob(fc, { id: id('res'), label: 'RESSON.', size: 'xs', min: 0, max: 1, def: 0, format: fmt.pct, title: 'Ressonância dos filtros (som "assobiado")', onChange: (v) => deck.setFilterRes(v) });

    const eq = h('div', 'eq-sec', tone);
    h('div', 'sec-label', eq, 'EQUALIZADOR');
    const er = h('div', 'krow eq-row', eq);
    const kr = h('div', 'krow kill-row', eq);
    [['high', 'AGUDO', 'green'], ['mid', 'MÉDIO', 'gold'], ['low', 'GRAVE', 'red']].forEach(([b, l, c]) => {
      new Knob(er, { id: id(`eq.${b}`), label: l, size: 'xs', color: c, min: -1, max: 1, def: 0, bipolar: true,
        format: (v) => (v <= -0.999 ? 'CORTADO' : fmt.db(v < 0 ? -40 * v * v : 12 * v)), onChange: (v) => deck.setEq(b, v) });
      new Btn(kr, { id: id(`kill.${b}`), mode: 'toggle', label: 'CORTA', cls: 'xs kill', title: `Corta todo o ${l.toLowerCase()}`, onChange: (v) => deck.setEqKill(b, v) });
    });

    // sends
    const sd = h('div', 'send-sec', s);
    h('div', 'sec-label', sd, 'MANDAR PARA OS EFEITOS');
    const sr = h('div', 'krow send-row', sd);
    const ec = h('div', 'kcol', sr);
    new Knob(ec, { id: id('send.echo'), label: 'ECO', size: 's', color: 'gold', min: 0, max: 1, def: 0, format: fmt.pct, title: 'Quanto deste canal vai para o eco', onChange: (v) => deck.setSend('echo', v) });
    ui.throwE = new Btn(ec, { label: 'JOGAR', mode: 'hold', cls: 'xs throw', color: 'gold', title: `Joga no eco enquanto segura — tecla ${'ASDF'[i]}`, onChange: (v) => deck.throwSend('echo', v) });
    const rc = h('div', 'kcol', sr);
    new Knob(rc, { id: id('send.rev'), label: 'REVERB', size: 's', color: 'green', min: 0, max: 1, def: 0, format: fmt.pct, title: 'Quanto deste canal vai para o reverb de mola', onChange: (v) => deck.setSend('rev', v) });
    ui.throwR = new Btn(rc, { label: 'JOGAR', mode: 'hold', cls: 'xs throw', color: 'green', title: 'Joga no reverb enquanto segura', onChange: (v) => deck.throwSend('rev', v) });

    const ms = h('div', 'krow ms', s);
    ui.mute = new Btn(ms, { id: id('mute'), mode: 'toggle', label: 'MUDO', cls: 'xs', color: 'red', title: 'Silencia este canal', onChange: (v) => deck.setMute(v) });
    ui.solo = new Btn(ms, { id: id('solo'), mode: 'toggle', label: 'SOLO', cls: 'xs', color: 'gold', title: 'Ouve só este canal', onChange: (v) => deck.setSolo(v) });

    const fz = h('div', 'fader-zone', s);
    new Fader(fz, { id: id('fader'), def: 0.8, value: 0.8, format: (v) => {
      const g = v <= 0 ? 0 : v < 0.8 ? Math.pow(v / 0.8, 2.6) : Math.pow(10, ((v - 0.8) * 30) / 20);
      return g <= 0 ? '-∞' : fmt.db(20 * Math.log10(g));
    }, onChange: (v) => deck.setFader(v) });
    ui.meter = new Meter(fz, { channels: 1, segments: 24, cls: 'strip-meter' });
    this.stripUI[i] = ui;
  }

  // ---------------------------------------------------------------- siren
  buildSiren(p) {
    const e = this.engine;
    const s = h('div', 'unit siren', p);
    const hd = h('div', 'unit-head', s);
    h('span', 'unit-name', hd, 'SIRENE');
    h('span', 'unit-model', hd, 'escolha um som e segure o botão');
    const pg = h('div', 'siren-presets', s);
    this.sirenPresetBtns = Object.keys(SIREN_PRESETS).map((k) => {
      const b = new Btn(pg, { label: SIREN_PT[k] || k, cls: 'xs', onChange: () => this.setSirenPreset(k) });
      b.name = k;
      return b;
    });
    const k1 = h('div', 'krow', s);
    this.sirenKnobs = {
      pitch: new Knob(k1, { label: 'TOM', size: 's', color: 'red', min: 60, max: 2000, def: 620, persist: false, format: fmt.hz, onChange: (v) => e.siren.set('pitch', v) }),
      rate: new Knob(k1, { label: 'VELOC.', size: 's', color: 'gold', min: 0.1, max: 16, def: 5.5, persist: false, format: (v) => `${v.toFixed(2)} Hz`, onChange: (v) => e.siren.set('rate', v) }),
      depth: new Knob(k1, { label: 'VARIAÇÃO', size: 's', color: 'green', min: 0, max: 1.5, def: 0.55, persist: false, format: (v) => `${Math.round(v * 12)} st`, onChange: (v) => e.siren.set('depth', v) }),
    };
    const k2 = h('div', 'krow', s);
    Object.assign(this.sirenKnobs, {
      decay: new Knob(k2, { label: 'CAUDA', size: 's', min: 0.05, max: 4, def: 0.9, persist: false, format: fmt.sec, onChange: (v) => e.siren.set('decay', v) }),
      sweep: new Knob(k2, { label: 'QUEDA', size: 's', min: 0, max: 1, def: 0.35, persist: false, format: fmt.pct, onChange: (v) => e.siren.set('sweep', v) }),
      vol: new Knob(k2, { id: 'siren.vol', label: 'VOLUME', size: 's', min: 0, max: 1, def: 0.5, format: fmt.pct, onChange: (v) => e.siren.output.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02) }),
    });
    const k3 = h('div', 'krow', s);
    this.sirenWave = new Choice(k3, { label: 'ONDA', options: ['square', 'sawtooth', 'triangle', 'sine'], labels: WAVE_PT, value: 'square', persist: false, cls: 'mini', onChange: (v) => e.siren.set('wave', v) });
    this.sirenLfo = new Choice(k3, { label: 'MODULAÇÃO', options: ['square', 'sine', 'triangle', 'sawtooth', 'sawdown'], labels: WAVE_PT, value: 'square', persist: false, cls: 'mini', onChange: (v) => e.siren.set('lfoWave', v) });
    const k4 = h('div', 'krow', s);
    new Knob(k4, { id: 'siren.echo', label: '→ECO', size: 's', color: 'gold', min: 0, max: 1, def: 0.7, format: fmt.pct, onChange: (v) => e.sirenEcho.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02) });
    new Knob(k4, { id: 'siren.rev', label: '→REVERB', size: 's', color: 'green', min: 0, max: 1, def: 0.25, format: fmt.pct, onChange: (v) => e.sirenRev.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02) });
    const trig = h('div', 'siren-trig', s);
    this.sirenBtn = new Btn(trig, { label: 'SIRENE', mode: 'hold', cls: 'big-trigger', color: 'red', title: 'Segure para tocar (tecla ESPAÇO)', onChange: (v) => (v ? e.siren.on() : e.siren.off()) });
    this.sirenLatch = new Btn(trig, { label: 'FIXAR', mode: 'toggle', persist: false, cls: 'xs', title: 'Deixa a sirene tocando sem segurar (aperte de novo para parar)', onChange: (v) => (v ? e.siren.on() : e.siren.off()) });
  }

  setSirenPreset(name) {
    const p = SIREN_PRESETS[name];
    if (!p) return;
    this.engine.siren.apply(p);
    for (const k of ['pitch', 'rate', 'depth', 'decay', 'sweep']) this.sirenKnobs[k].set(p[k], false);
    this.sirenWave.set(p.wave, false);
    this.sirenLfo.set(p.lfoWave, false);
    this.sirenPresetBtns.forEach((b) => b.el.classList.toggle('on', b.name === name));
    this.sirenPreset = name;
  }

  // ---------------------------------------------------------------- tape echo
  buildEcho(p) {
    const e = this.engine;
    const u = h('div', 'unit echo', p);
    const hd = h('div', 'unit-head', u);
    h('span', 'unit-name', hd, 'ECO');
    h('span', 'unit-model', hd, 'eco de fita · tempo no ritmo da música');
    this.echoLcd = h('div', 'lcd echo-lcd', hd, '1/4D · 600 ms');
    const divs = h('div', 'div-grid', u);
    this.divBtns = Object.keys(DIVISIONS).map((d) => {
      const b = new Btn(divs, { label: d, cls: 'xs', onChange: () => { this.divChoice.set(d); } });
      b.div = d;
      return b;
    });
    this.divChoice = { value: '1/4D', persist: undefined, set: (v, silent) => {
      if (!DIVISIONS[v]) return;
      this.divChoice.value = v;
      e.setEchoDivision(v);
      this.divBtns.forEach((b) => b.el.classList.toggle('on', b.div === v && e.echoSync));
      this.updateEchoLcd();
    } };
    // register division as preset parameter
    registry.set('echo.div', this.divChoice);
    const k1 = h('div', 'krow', u);
    new Knob(k1, { label: 'TEMPO', size: 'm', color: 'gold', min: 20, max: 1800, def: 375, persist: false, format: fmt.ms, title: 'Tempo livre (sai do sync) — gire durante o eco para o efeito de pitch da fita', onChange: (v) => {
      e.setEchoFree(v);
      this.divBtns.forEach((b) => b.el.classList.remove('on'));
      this.updateEchoLcd();
    } });
    new Knob(k1, { id: 'echo.feedback', label: 'REPETIÇÕES', title: 'Quantas vezes o eco repete (acima de 100% fica infinito)', size: 'm', color: 'red', min: 0, max: 1.15, def: 0.5, format: (v) => `${Math.round(v * 100)}%${v >= 1 ? ' ∞' : ''}`, onChange: (v) => e.echo.setFeedback(v) });
    new Knob(k1, { id: 'echo.tone', label: 'TIMBRE', size: 'm', min: -1, max: 1, def: 0, bipolar: true, format: (v) => (v < -0.02 ? `ESCURO ${Math.round(-v * 100)}` : v > 0.02 ? `FINO ${Math.round(v * 100)}` : 'NORMAL'), onChange: (v) => e.echo.setTone(v) });
    const k2 = h('div', 'krow', u);
    new Knob(k2, { id: 'echo.wow', label: 'BALANÇO', title: 'Oscilação de fita velha', size: 's', min: 0, max: 1, def: 0.15, format: fmt.pct, onChange: (v) => e.echo.setWow(v) });
    new Knob(k2, { id: 'echo.drive', label: 'SUJEIRA', title: 'Saturação da fita', size: 's', min: 0, max: 1, def: 0.3, format: fmt.pct, onChange: (v) => e.echo.setDrive(v) });
    new Knob(k2, { id: 'echo.spread', label: 'ABERTURA', title: 'Espalha o eco entre esquerda e direita', size: 's', min: 0, max: 1, def: 0.4, format: fmt.pct, onChange: (v) => e.echo.setSpread(v) });
    new Knob(k2, { id: 'echo.torev', label: '→REVERB', size: 's', color: 'green', min: 0, max: 1, def: 0.25, format: fmt.pct, onChange: (v) => e.echoToRev.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02) });
    new Knob(k2, { id: 'echo.return', label: 'VOLUME', size: 's', color: 'gold', min: 0, max: 1.5, def: 0.9, format: fmt.pct, onChange: (v) => e.echoReturn.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02) });
    const b = h('div', 'krow btns', u);
    new Btn(b, { label: 'CONGELAR', mode: 'hold', cls: 'xs', color: 'blue', title: 'Prende o eco num loop enquanto segura (tecla G)', onChange: (v) => e.echo.freeze(v) });
    new Btn(b, { label: 'JOGAR TUDO', mode: 'hold', cls: 'xs', color: 'gold', title: 'Joga a mix inteira no eco enquanto segura (tecla T)', onChange: (v) => e.masterEchoThrow(v) });
    new Btn(b, { label: 'LIMPAR', cls: 'xs', color: 'red', title: 'Corta todos os ecos (tecla ESC)', onChange: () => e.echo.clear() });
  }
  updateEchoLcd() {
    const e = this.engine;
    const ms = Math.round(e.echo.params.time * 1000);
    this.echoLcd.textContent = e.echoSync ? `${e.echoDiv} · ${ms} ms` : `LIVRE · ${ms} ms`;
  }

  // ---------------------------------------------------------------- spring
  buildSpring(p) {
    const e = this.engine;
    const u = h('div', 'unit spring', p);
    const hd = h('div', 'unit-head', u);
    h('span', 'unit-name', hd, 'REVERB DE MOLA');
    h('span', 'unit-model', hd, 'ambiência clássica do dub');
    const k = h('div', 'krow', u);
    new Knob(k, { id: 'spring.decay', label: 'DURAÇÃO', size: 'm', color: 'green', min: 0.4, max: 5.5, def: 2.4, format: fmt.sec, onChange: (v) => e.spring.setDecay(v) });
    new Knob(k, { id: 'spring.drip', label: 'GOTEJAR', title: 'O "ploc" metálico da mola', size: 'm', color: 'gold', min: 0, max: 1, def: 0.55, format: fmt.pct, onChange: (v) => e.spring.setDrip(v) });
    const k2 = h('div', 'krow', u);
    new Knob(k2, { id: 'spring.tone', label: 'TIMBRE', size: 's', min: -1, max: 1, def: 0, bipolar: true, format: (v) => (Math.abs(v) < 0.02 ? 'NORMAL' : v.toFixed(2)), onChange: (v) => e.spring.setTone(v) });
    new Knob(k2, { id: 'spring.return', label: 'VOLUME', size: 's', color: 'green', min: 0, max: 1.5, def: 1.0, format: fmt.pct, onChange: (v) => e.revReturn.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02) });
    const b = h('div', 'krow btns', u);
    new Btn(b, { label: 'PANCADA!', cls: 'xs crash', color: 'red', title: 'Chuta a caixa de molas — estrondo clássico (tecla H)', onChange: () => e.spring.crash() });
  }

  // ---------------------------------------------------------------- phaser
  buildPhaser(p) {
    const e = this.engine;
    const u = h('div', 'unit phaser', p);
    const hd = h('div', 'unit-head', u);
    h('span', 'unit-name', hd, 'PHASER');
    h('span', 'unit-model', hd, 'som "girando" na mix toda');
    new Btn(hd, { id: 'phaser.on', mode: 'toggle', label: 'LIGAR', cls: 'xs', color: 'green', onChange: (v) => e.phaser.setMix(v ? this.phaserMix : 0) });
    this.phaserMix = 0.5;
    const k = h('div', 'krow', u);
    new Knob(k, { id: 'phaser.rate', label: 'VELOC.', size: 's', color: 'blue', min: 0.02, max: 6, def: 0.25, format: (v) => `${v.toFixed(2)} Hz`, onChange: (v) => e.phaser.setRate(v) });
    new Knob(k, { id: 'phaser.depth', label: 'INTENSID.', size: 's', min: 0, max: 1, def: 0.7, format: fmt.pct, onChange: (v) => e.phaser.setDepth(v) });
    new Knob(k, { id: 'phaser.center', label: 'CENTRO', size: 's', min: 0, max: 1, def: 0.5, format: (v) => fmt.hz(200 * Math.pow(2, v * 4.5)), onChange: (v) => e.phaser.setCenter(v) });
    const k2 = h('div', 'krow', u);
    new Knob(k2, { id: 'phaser.feedback', label: 'RETORNO', size: 's', min: 0, max: 0.85, def: 0.3, format: fmt.pct, onChange: (v) => e.phaser.setFeedback(v) });
    new Knob(k2, { id: 'phaser.mix', label: 'MISTURA', size: 's', color: 'blue', min: 0, max: 1, def: 0.5, format: fmt.pct, onChange: (v) => {
      this.phaserMix = v;
      const on = this.root.querySelector('.phaser .btn.on');
      if (on) e.phaser.setMix(v);
    } });
  }

  // ---------------------------------------------------------------- master
  buildMaster(p) {
    const e = this.engine;
    const hd = h('div', 'unit-head', p);
    h('span', 'unit-name', hd, 'SAÍDA GERAL');
    const top = h('div', 'master-grid', p);
    const left = h('div', 'master-left', top);
    h('div', 'sec-label', left, 'FILTRO GERAL');
    const fr = h('div', 'krow', left);
    this.mfKnob = new Knob(fr, { id: 'master.filter', label: 'ABAFA ◂ ▸ TIRA GRAVE', size: 'l', color: 'gold', min: -1, max: 1, def: 0, bipolar: true, title: 'Esquerda: abafa a mix. Direita: tira o grave. Meio: desligado',
      format: (v) => (Math.abs(v) < 0.01 ? 'DESL.' : v < 0 ? `ABAFA ${fmt.hz(22000 * Math.pow(2, v * 9.4))}` : `GRAVE ${fmt.hz(10 * Math.pow(2, v * 10.2))}`),
      onChange: (v) => e.setMasterFilter(v, this.mfRes ?? 0.2) });
    new Knob(fr, { id: 'master.res', label: 'RESSON.', size: 's', min: 0, max: 1, def: 0.2, format: fmt.pct, onChange: (v) => { this.mfRes = v; e.setMasterFilter(this.mfKnob.value, v); } });
    h('div', 'sec-label', left, 'EQUALIZADOR GERAL');
    const eq1 = h('div', 'krow', left);
    new Knob(eq1, { id: 'master.sub', label: 'SUB', size: 's', color: 'red', min: -12, max: 12, def: 0, bipolar: true, format: fmt.db, onChange: (v) => e.setEq('sub', v) });
    new Knob(eq1, { id: 'master.low', label: 'GRAVE', size: 's', color: 'red', min: -12, max: 12, def: 0, bipolar: true, format: fmt.db, onChange: (v) => e.setEq('low', v) });
    const eq2 = h('div', 'krow', left);
    new Knob(eq2, { id: 'master.pres', label: 'PRESENÇA', size: 's', color: 'gold', min: -12, max: 12, def: 0, bipolar: true, format: fmt.db, onChange: (v) => e.setEq('pres', v) });
    new Knob(eq2, { id: 'master.air', label: 'BRILHO', size: 's', color: 'green', min: -12, max: 12, def: 0, bipolar: true, format: fmt.db, onChange: (v) => e.setEq('air', v) });
    const dyn = h('div', 'krow', left);
    new Knob(dyn, { id: 'master.glue', label: 'COMPRESSÃO', title: 'Deixa a mix mais encorpada e colada', size: 's', min: 0, max: 1, def: 0.2, format: fmt.pct, onChange: (v) => e.setGlue(v) });
    new Btn(dyn, { id: 'master.limiter', mode: 'toggle', value: true, label: 'PROTEÇÃO', cls: 'xs', color: 'green', title: 'Limitador: evita que o som distorça/estoure', onChange: (v) => e.setLimiter(v) });

    const right = h('div', 'master-right', top);
    const fz = h('div', 'fader-zone master-fz', right);
    new Fader(fz, { id: 'master.gain', min: -60, max: 6, def: -6, value: -6, capColor: 'red', marks: ['+6', '0', '-6', '-12', '-24', '-36', '-∞'],
      format: (v) => (v <= -59.9 ? '-∞' : fmt.db(v)), onChange: (v) => e.setMasterGain(v) });
    this.masterMeter = new Meter(fz, { channels: 2, segments: 30, cls: 'master-meter' });
    this.limLed = h('div', 'clip-led lim', right, 'LIMITE');
    this.clipLed = h('div', 'clip-led', right, 'ESTOURO');
    this.spec = h('canvas', 'spectrum', p);
    const bd = h('div', 'krow btns', p);
    new Btn(bd, { label: 'TIRAR GRAVE', mode: 'hold', cls: 'xs', color: 'red', title: 'Tira o grave da mix enquanto segura (tecla B)', onChange: (v) => e.bassDrop(v) });
  }

  // ---------------------------------------------------------------- pads
  buildPads(p) {
    const e = this.engine;
    const hd = h('div', 'unit-head', p);
    h('span', 'unit-name', hd, 'SONS DE SOUND SYSTEM');
    h('span', 'unit-model', hd, 'clique para tocar · teclas 1–8 · ESPAÇO = sirene');
    this.padsDeskHost = h('div', 'desk-host wide', p);
    const grid = h('div', 'pad-grid', p);
    const sfx = [
      ['AIRHORN', 'BUZINA', 'red'], ['GUNSHOT', 'TIRO', 'red'], ['LASER', 'LASER', 'gold'], ['BOMB', 'BOMBA', 'red'],
      ['ZAP', 'ZAP', 'gold'], ['RISER', 'SUBIDA', 'green'], ['SUBDROP', 'QUEDA GRAVE', 'red'], ['RIMSHOT', 'ARO', 'green'],
    ];
    this.pads = sfx.map(([k, l, c], idx) => {
      const b = new Btn(grid, { label: l, cls: `pad`, color: c, title: `Tecla ${idx + 1}`, onChange: () => e.playSfx(k) });
      return b;
    });
    new Btn(grid, { label: 'SIRENE', mode: 'hold', cls: 'pad', color: 'red', title: 'Segure', onChange: (v) => (v ? e.siren.on() : e.siren.off()) });
    new Btn(grid, { label: 'PANCADA NA MOLA', cls: 'pad', color: 'green', onChange: () => e.spring.crash() });
    new Btn(grid, { label: 'JOGAR NO ECO', mode: 'hold', cls: 'pad', color: 'gold', title: 'Segure', onChange: (v) => e.masterEchoThrow(v) });
    new Btn(grid, { label: 'TIRAR GRAVE', mode: 'hold', cls: 'pad', color: 'red', title: 'Segure', onChange: (v) => e.bassDrop(v) });
    this.dubOutBtn = new Btn(grid, { label: 'SÓ BATIDA', mode: 'hold', cls: 'pad', color: 'gold', title: 'Todas as músicas ficam só com bateria e baixo enquanto segura (tecla V)', onChange: (v) => this.dubOut(v) });
    new Btn(grid, { label: 'SEM VOZ', mode: 'hold', cls: 'pad', color: 'green', title: 'Tira a voz de todas as músicas enquanto segura', onChange: (v) => this.noVocal(v) });
    new Btn(grid, { label: 'CONGELAR ECO', mode: 'hold', cls: 'pad', color: 'blue', title: 'Segure', onChange: (v) => e.echo.freeze(v) });
    new Btn(grid, { label: 'LIMPAR ECO', cls: 'pad', color: 'blue', onChange: () => e.echo.clear() });

    h('div', 'sec-label pads-sub', p, 'SEUS SAMPLES (clique num vazio para escolher um arquivo · clique direito ou segure para trocar)');
    const ug = h('div', 'pad-grid user', p);
    this.userPads = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
      const input = h('input', '', p);
      input.type = 'file';
      input.accept = 'audio/*';
      input.style.display = 'none';
      const pad = { buffer: null, name: null };
      const b = new Btn(ug, { label: `+ SAMPLE ${k + 1}`, cls: 'pad user-pad', onChange: () => {
        if (pad.buffer) { e.resume(); e.playSample(pad.buffer); } else input.click();
      } });
      const replace = (ev) => { ev.preventDefault(); input.click(); };
      b.el.addEventListener('contextmenu', replace);
      let t;
      b.el.addEventListener('touchstart', () => { t = setTimeout(() => input.click(), 700); }, { passive: true });
      b.el.addEventListener('touchend', () => clearTimeout(t));
      input.onchange = async () => {
        const f = input.files[0];
        input.value = '';
        if (!f) return;
        try {
          const ab = await f.arrayBuffer();
          const copy = ab.slice(0);
          pad.buffer = await e.ctx.decodeAudioData(ab);
          pad.name = f.name.replace(/\.[^.]+$/, '');
          b.label(pad.name.slice(0, 18));
          b.el.classList.add('loaded');
          kvSet(`pad${k}`, { name: pad.name, data: copy });
        } catch (err) {
          toast(`Não consegui abrir "${f.name}"`, 'err');
        }
      };
      pad.btn = b;
      return pad;
    });
  }

  async loadUserPads() {
    for (let k = 0; k < this.userPads.length; k++) {
      const rec = await kvGet(`pad${k}`);
      if (!rec || !rec.data) continue;
      try {
        const pad = this.userPads[k];
        pad.buffer = await this.engine.ctx.decodeAudioData(rec.data.slice(0));
        pad.name = rec.name;
        pad.btn.label(rec.name.slice(0, 18));
        pad.btn.el.classList.add('loaded');
      } catch (e) { /* ignore broken entry */ }
    }
  }

  dubOut(on) {
    if (on) {
      this._savedKills = this.decks.map((d) => d.stemKill.slice());
      this.decks.forEach((d) => d.stemMode('DUB'));
    } else if (this._savedKills) {
      this.decks.forEach((d, i) => { d.stemKill = this._savedKills[i]; d._sendStems(); this.engine.emit('deck-stems', d); });
      this._savedKills = null;
    }
  }
  noVocal(on) {
    if (on) {
      this._savedV = this.decks.map((d) => d.stemKill[0]);
      this.decks.forEach((d) => { d.setStemKill(0, true); this.engine.emit('deck-stems', d); });
    } else if (this._savedV) {
      this.decks.forEach((d, i) => { d.setStemKill(0, this._savedV[i]); this.engine.emit('deck-stems', d); });
      this._savedV = null;
    }
  }

  // ---------------------------------------------------------------- recording
  async toggleRec(on) {
    const e = this.engine;
    await e.resume();
    if (on) {
      e.startRecording();
      setDirty(true);
      toast('● Gravando tudo o que sai da mesa', 'rec');
    } else if (e.recording) {
      const take = await e.stopRecording();
      if (take.channels[0].length < e.ctx.sampleRate * 0.5) { toast('Gravação muito curta', 'warn'); return; }
      take.name = `Dub Take ${this.takes.length + 1}`;
      take.bpm = e.bpm;
      take.date = new Date();
      take.exported = false;
      this.takes.push(take);
      this.studio.open(take);
    }
  }

  // ---------------------------------------------------------------- engine events
  onEngine(type, d) {
    if (type === 'bpm') {
      this.bpmLcd.textContent = d.toFixed(1);
      if (this.echoLcd) this.updateEchoLcd();
    }
    if (type === 'deck-load') {
      const ui = this.deckUI[d.index];
      ui.name.textContent = d.meta ? d.meta.name : '— vazio —';
      this.stripUI[d.index].title.textContent = d.meta ? d.meta.name : '—';
    }
    if (type === 'deck-stems') {
      const ui = this.stripUI[d.index];
      ui.stemKill.forEach((b, k) => b.set(d.stemKill[k], false));
    }
  }

  // ---------------------------------------------------------------- animation
  loop() {
    requestAnimationFrame(this.loop);
    const e = this.engine;
    this.decks.forEach((d, i) => {
      const ui = this.deckUI[i];
      if (document.body.dataset.view === 'decks') ui.wave.draw(); // hidden canvases have 0 size
      const pos = d.position;
      ui.time.textContent = fmtTime(pos);
      ui.remain.textContent = '-' + fmtTime(Math.max(0, d.duration - pos));
      const bpmTxt = d.bpm ? (d.bpm * d.rate).toFixed(1) : d.buffer ? '…' : '---.-';
      if (ui.bpm.textContent !== bpmTxt) ui.bpm.textContent = bpmTxt;
      ui.play.label(d.playing ? '❚❚' : '▶');
      ui.play.el.classList.toggle('on', d.playing);
      ui.card.classList.toggle('playing', d.playing);
      ui.card.classList.toggle('loaded', !!d.buffer);
      ui.card.classList.toggle('busy', d.busyFx);
      ui.hot.forEach((b, k) => b.el.classList.toggle('set', d.hotCues[k] != null));
      ui.loops.forEach((b, k) => b.el.classList.toggle('on', !!d.loop && d.loop.beats === [1, 2, 4, 8, 16][k]));
      const pt = `${d.rate >= 1 ? '+' : ''}${((d.rate - 1) * 100).toFixed(2)}%`;
      if (ui.pitchLcd.textContent !== pt) ui.pitchLcd.textContent = pt;
      const kills = d.stemKill.map((v) => (v ? 1 : 0)).join(',');
      ui.sep.forEach((b) => b.el.classList.toggle('on', kills === SEP_KILLS[b.mode]));
      if (Math.abs(ui.vol.value - d.faderValue) > 1e-4) ui.vol.set(d.faderValue, false);
      const lvl = d.level();
      this.stripUI[i].meter.update([lvl]);
      this.stripUI[i].mute.el.classList.toggle('dim', e.anySolo() && !d.solo);
    });
    const lv = e.masterLevels();
    this.masterMeter.update([lv[0].peak, lv[1].peak]);
    if (lv[0].peak > 0.985 || lv[1].peak > 0.985) this.clipT = performance.now();
    this.clipLed.classList.toggle('on', performance.now() - (this.clipT || 0) < 600);
    if (e.limiterOn && e.limiter.reduction < -1) this.limT = performance.now();
    this.limLed.classList.toggle('on', performance.now() - (this.limT || 0) < 300);
    this.drawSpectrum();
    for (const [k, src] of this.deskMirrors || []) if (Math.abs(k.value - src.value) > 1e-4) k.set(src.value, false);
    this.tickFx(performance.now());
    if (e.recording) this.recLcd.textContent = fmtTime((performance.now() - e.recStart) / 1000);
  }

  drawSpectrum() {
    const c = this.spec;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const an = this.engine.spec;
    if (!this._fdata) this._fdata = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(this._fdata);
    const sr = this.engine.ctx.sampleRate;
    const bars = 32;
    const bw = W / bars;
    for (let b = 0; b < bars; b++) {
      const f0 = 25 * Math.pow(18000 / 25, b / bars), f1 = 25 * Math.pow(18000 / 25, (b + 1) / bars);
      const i0 = Math.floor((f0 / (sr / 2)) * this._fdata.length), i1 = Math.max(i0 + 1, Math.floor((f1 / (sr / 2)) * this._fdata.length));
      let m = -140;
      for (let i = i0; i < i1; i++) m = Math.max(m, this._fdata[i]);
      const v = Math.max(0, Math.min(1, (m + 90) / 80));
      const col = b < bars * 0.3 ? '#e8412c' : b < bars * 0.65 ? '#f2b705' : '#2fbf71';
      g.fillStyle = col;
      g.fillRect(b * bw + 1, H - v * H, bw - 2, v * H);
    }
  }

  // ---------------------------------------------------------------- keyboard
  bindKeys() {
    const e = this.engine;
    const held = new Set();
    const isField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    window.addEventListener('keydown', (ev) => {
      if (isField(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (this.studio.isOpen() || document.querySelector('.modal-back')) return;
      const k = ev.key.toLowerCase();
      if (held.has(k)) { if (k === ' ') ev.preventDefault(); return; }
      held.add(k);
      e.resume();
      const deckKeys = { q: 0, w: 1, e: 2, r: 3 };
      const throwKeys = { a: 0, s: 1, d: 2, f: 3 };
      if (k in deckKeys) this.decks[deckKeys[k]].toggle();
      else if (k in throwKeys) { this.decks[throwKeys[k]].throwSend('echo', true); this.stripUI[throwKeys[k]].throwE.el.classList.add('on'); }
      else if (k >= '1' && k <= '8') this.pads[+k - 1].press();
      else if (k === ' ') { ev.preventDefault(); e.siren.on(); this.sirenBtn.el.classList.add('on'); }
      else if (k === 't') e.masterEchoThrow(true);
      else if (k === 'b') e.bassDrop(true);
      else if (k === 'g') e.echo.freeze(true);
      else if (k === 'h') e.spring.crash();
      else if (k === 'v') this.dubOut(true);
      else if (k === 'y') this.tap();
      else if (k === 'enter') { ev.preventDefault(); this.recBtn.press(); }
      else if (k === 'escape') e.echo.clear();
      else if (k === '?') this.showHelp();
    });
    window.addEventListener('keyup', (ev) => {
      const k = ev.key.toLowerCase();
      if (!held.has(k)) return;
      held.delete(k);
      const throwKeys = { a: 0, s: 1, d: 2, f: 3 };
      if (k in throwKeys) { this.decks[throwKeys[k]].throwSend('echo', false); this.stripUI[throwKeys[k]].throwE.el.classList.remove('on'); }
      else if (k === ' ') { e.siren.off(); this.sirenBtn.el.classList.remove('on'); }
      else if (k === 't') e.masterEchoThrow(false);
      else if (k === 'b') e.bassDrop(false);
      else if (k === 'g') e.echo.freeze(false);
      else if (k === 'v') this.dubOut(false);
    });
    // safety: release everything if the window loses focus
    window.addEventListener('blur', () => {
      held.clear();
      this.decks.forEach((d) => { d.throwSend('echo', false); d.throwSend('rev', false); });
      if (!this.sirenLatch.value) e.siren.off();
      e.masterEchoThrow(false);
      e.bassDrop(false);
      e.echo.freeze(false);
      if (this._savedKills) this.dubOut(false);
    });
  }

  showHelp() {
    const m = h('div', 'modal-back', document.body);
    const box = h('div', 'modal help', m);
    h('h2', '', box, 'COMO USAR');
    const steps = [
      ['1. Abra uma música', 'Botão ＋ ABRIR MÚSICA (ou arraste o arquivo para um deck). Sem música? Use DEMO 1 ou DEMO 2.'],
      ['2. Toque', 'Botão ▶ do deck. O VOLUME de cada deck fica na própria linha SEPARAR.'],
      ['3. Tire a voz', 'Na linha SEPARAR do deck: SEM VOZ tira a voz, SÓ VOZ deixa só a voz, SÓ BATIDA deixa bateria e baixo, TUDO volta ao normal.'],
      ['4. Solte efeitos', 'Na aba MÚSICAS tem os EFEITOS RÁPIDOS; na aba EFEITOS ficam a sirene, o eco e o reverb; na aba SONS ficam todos os sons e seus samples.'],
      ['5. Esqueceu algo ligado?', 'A barra EFEITOS LIGADOS mostra tudo que está ativo. Clique num efeito para desligar, ou em ■ PARAR TUDO. A LINHA DO TEMPO mostra o que você usou no último minuto.'],
      ['6. Grave', 'GRAVAR (ou ENTER) começa e para a gravação. Depois é só exportar em WAV ou MP3.'],
    ];
    const g = h('div', 'help-steps', box);
    steps.forEach(([a, b]) => { const r = h('div', 'help-step', g); h('b', '', r, a); h('span', '', r, b); });
    h('h2', 'help-sub', box, 'ATALHOS DE TECLADO');
    const rows = [
      ['Q W E R', 'Tocar / pausar os decks A B C D'], ['A S D F (segure)', 'Jogar o deck A B C D no eco'],
      ['ESPAÇO (segure)', 'Sirene'], ['1 – 8', 'Sons (buzina, tiro, laser…)'],
      ['T (segure)', 'Jogar a mix inteira no eco'], ['G (segure)', 'Congelar o eco'],
      ['ESC', 'Limpar todos os ecos'], ['B (segure)', 'Tirar o grave'], ['V (segure)', 'Só batida em tudo'],
      ['H', 'Pancada na mola'], ['Y', 'Bater o BPM'], ['ENTER', 'Gravar / parar'],
      ['Duplo clique', 'Volta o botão/fader ao normal'], ['Shift + arrastar', 'Ajuste fino'],
    ];
    const t = h('table', '', box);
    rows.forEach(([a, b]) => { const tr = h('tr', '', t); h('td', 'k', tr, a); h('td', '', tr, b); });
    h('p', 'muted small', box, `DUB-MIXER v1.0 · ${platformName} · ${this.engine.ctx.sampleRate} Hz`);
    const c = h('button', 'btn wide', box, 'FECHAR');
    c.onclick = () => m.remove();
    m.onclick = (ev) => { if (ev.target === m) m.remove(); };
  }
}

export { saveFile };
