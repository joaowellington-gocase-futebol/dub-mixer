// Export Studio: trim, fades, normalize, metadata, cover art, WAV/MP3 export, send-to-deck.
import { h } from './controls.js';
import { encodeWav } from '../export/wav.js';
import { encodeMp3 } from '../export/mp3.js';
import { saveFile, setDirty } from '../platform.js';
import { toast } from './toast.js';

const FORMATS = {
  'WAV 24-bit': { ext: 'wav', bits: 24 },
  'WAV 16-bit': { ext: 'wav', bits: 16 },
  'WAV 32-bit float': { ext: 'wav', bits: 32 },
  'MP3 320 kbps': { ext: 'mp3', kbps: 320 },
  'MP3 256 kbps': { ext: 'mp3', kbps: 256 },
  'MP3 192 kbps': { ext: 'mp3', kbps: 192 },
};

const META_KEY = 'dubmixer.lastMeta';
const fmtT = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'dub';

export class ExportStudio {
  constructor(engine, app) {
    this.engine = engine;
    this.app = app;
    this.el = null;
  }
  isOpen() { return !!this.el; }

  close() {
    this.stopPreview();
    if (this.el) this.el.remove();
    this.el = null;
    cancelAnimationFrame(this.raf);
  }

  openTakes() {
    const takes = this.app.takes;
    this.close();
    const back = h('div', 'modal-back', document.body);
    this.el = back;
    const box = h('div', 'modal takes', back);
    h('h2', '', box, 'GRAVAÇÕES DA SESSÃO');
    if (!takes.length) h('p', 'muted', box, 'Nenhuma gravação ainda. Aperte GRAVAR (ou ENTER), mixe o seu dub e aperte GRAVAR de novo para parar.');
    takes.forEach((t, i) => {
      const row = h('div', 'take-row', box);
      h('span', 'take-name', row, t.name);
      h('span', 'muted', row, `${fmtT(t.channels[0].length / t.sampleRate)} · ${t.date.toLocaleTimeString()}${t.exported ? ' · exportada ✓' : ''}`);
      const o = h('button', 'btn sm', row, 'ABRIR');
      o.onclick = () => this.open(t);
      const d = h('button', 'btn sm c-red', row, 'APAGAR');
      d.onclick = () => {
        if (!confirm(`Apagar "${t.name}"?`)) return;
        takes.splice(i, 1);
        setDirty(takes.some((x) => !x.exported));
        this.openTakes();
      };
    });
    const c = h('button', 'btn wide', box, 'FECHAR');
    c.onclick = () => this.close();
  }

  open(take) {
    this.close();
    this.take = take;
    const sr = take.sampleRate;
    const len = take.channels[0].length;
    const dur = len / sr;
    let last = {};
    try { last = JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { /* noop */ }
    this.st = {
      start: 0, end: dur, fadeIn: 0.05, fadeOut: 1.5, normalize: true, target: -1,
      format: last.format || 'WAV 24-bit',
      title: take.title || take.name, artist: last.artist || '', album: last.album || '', year: String(new Date().getFullYear()),
      genre: last.genre || 'Dub', comment: 'Mixed live on DUB-MIXER', cover: take.cover || null,
    };

    const back = h('div', 'modal-back', document.body);
    this.el = back;
    const box = h('div', 'modal studio', back);
    const head = h('div', 'studio-head', box);
    h('h2', '', head, 'EXPORTAR GRAVAÇÃO');
    this.durLcd = h('div', 'lcd', head, '');
    const x = h('button', 'btn sm', head, '✕');
    x.onclick = () => this.close();

    // waveform + trim
    const wv = h('div', 'studio-wave', box);
    this.cv = h('canvas', '', wv);
    this.peaks = this.makePeaks(take, 1600);
    this.bindTrim();
    const tr = h('div', 'studio-row', box);
    this.prevBtn = h('button', 'btn c-green', tr, '▶ OUVIR');
    this.prevBtn.onclick = () => (this.previewSrc ? this.stopPreview() : this.preview());
    const fi = this.numField(tr, 'FADE IN (s)', this.st.fadeIn, 0, 30, 0.05, (v) => { this.st.fadeIn = v; this.drawWave(); });
    const fo = this.numField(tr, 'FADE OUT (s)', this.st.fadeOut, 0, 60, 0.1, (v) => { this.st.fadeOut = v; this.drawWave(); });
    fi.parentNode.title = fo.parentNode.title = 'Duração do fade';
    const nl = h('label', 'chk', tr);
    const nc = h('input', '', nl); nc.type = 'checkbox'; nc.checked = this.st.normalize;
    nc.onchange = () => { this.st.normalize = nc.checked; };
    h('span', '', nl, 'NORMALIZAR (-1 dBFS)');
    const rs = h('button', 'btn sm', tr, 'RESET CORTE');
    rs.onclick = () => { this.st.start = 0; this.st.end = dur; this.drawWave(); };
    h('div', 'muted small', box, 'Arraste as bordas verdes para cortar o início e o fim da gravação.');

    const cols = h('div', 'studio-cols', box);
    // metadata
    const meta = h('div', 'studio-meta', cols);
    this.textField(meta, 'TÍTULO', 'title');
    this.textField(meta, 'ARTISTA', 'artist');
    this.textField(meta, 'ÁLBUM', 'album');
    const r2 = h('div', 'two', meta);
    this.textField(r2, 'ANO', 'year');
    this.textField(r2, 'GÊNERO', 'genre');
    this.textField(meta, 'COMENTÁRIO', 'comment');
    const fmtBox = h('div', 'field', meta);
    h('label', '', fmtBox, 'FORMATO');
    const sel = h('select', '', fmtBox);
    Object.keys(FORMATS).forEach((k) => { const o = h('option', '', sel, k); o.value = k; });
    sel.value = this.st.format;
    sel.onchange = () => { this.st.format = sel.value; };

    // cover
    const cov = h('div', 'studio-cover', cols);
    h('label', '', cov, 'CAPA (embutida no arquivo)');
    this.coverImg = h('div', 'cover-preview', cov);
    const cin = h('input', '', cov); cin.type = 'file'; cin.accept = 'image/*'; cin.style.display = 'none';
    cin.onchange = async () => { const f = cin.files[0]; cin.value = ''; if (f) await this.setCoverFromFile(f); };
    const cb = h('div', 'cover-btns', cov);
    const b1 = h('button', 'btn sm', cb, 'ESCOLHER IMAGEM'); b1.onclick = () => cin.click();
    const b2 = h('button', 'btn sm', cb, 'GERAR CAPA'); b2.onclick = () => this.generateCover();
    const b3 = h('button', 'btn sm', cb, 'SALVAR JPG'); b3.onclick = () => this.saveCover();
    this.coverImg.ondragover = (e) => e.preventDefault();
    this.coverImg.ondrop = (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this.setCoverFromFile(f); };
    this.coverImg.onclick = () => cin.click();
    if (!this.st.cover) this.generateCover(); else this.showCover();

    // actions
    const act = h('div', 'studio-actions', box);
    this.prog = h('div', 'progress', act);
    this.progBar = h('div', 'bar', this.prog);
    const ex = h('button', 'btn c-red big', act, '⬇ EXPORTAR');
    ex.onclick = () => this.export(ex);
    const sd = h('div', 'send-deck', act);
    h('span', 'muted', sd, 'MANDAR PARA O DECK:');
    ['A', 'B', 'C', 'D'].forEach((L, i) => {
      const b = h('button', 'btn sm', sd, L);
      b.onclick = () => this.sendToDeck(i);
    });
    this.updateDur();
    requestAnimationFrame(() => this.drawWave());
    this.onResize = () => this.drawWave();
    window.addEventListener('resize', this.onResize, { once: true });
  }

  textField(parent, label, key) {
    const f = h('div', 'field', parent);
    h('label', '', f, label);
    const i = h('input', '', f);
    i.value = this.st[key] || '';
    i.oninput = () => { this.st[key] = i.value; };
    return i;
  }
  numField(parent, label, val, min, max, step, onChange) {
    const f = h('label', 'num', parent);
    h('span', '', f, label);
    const i = h('input', '', f);
    i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = val;
    i.oninput = () => { const v = parseFloat(i.value); if (isFinite(v)) onChange(Math.max(min, Math.min(max, v))); };
    return i;
  }

  updateDur() {
    this.durLcd.textContent = `${fmtT(this.st.end - this.st.start)}  ·  ${this.take.sampleRate} Hz`;
  }

  makePeaks(take, n) {
    const [L, R] = take.channels;
    const per = Math.max(1, Math.floor(L.length / n));
    const mx = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let m = 0;
      for (let i = b * per, e = Math.min(L.length, (b + 1) * per); i < e; i++) {
        const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (a > m) m = a;
      }
      mx[b] = m;
    }
    return mx;
  }

  drawWave() {
    if (!this.cv) return;
    const c = this.cv;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0a0908'; g.fillRect(0, 0, W, H);
    const dur = this.take.channels[0].length / this.take.sampleRate;
    const p = this.peaks;
    for (let x = 0; x < W; x++) {
      const v = p[Math.floor((x / W) * p.length)] || 0;
      const t = (x / W) * dur;
      g.fillStyle = t < this.st.start || t > this.st.end ? '#3a332b' : '#f2b705';
      g.fillRect(x, H / 2 - v * H * 0.46, 1, Math.max(1, v * H * 0.92));
    }
    const xs = (this.st.start / dur) * W, xe = (this.st.end / dur) * W;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 0, xs, H); g.fillRect(xe, 0, W - xe, H);
    // fades
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.beginPath();
    g.moveTo(xs, H); g.lineTo(xs + (this.st.fadeIn / dur) * W, 0);
    g.moveTo(xe - (this.st.fadeOut / dur) * W, 0); g.lineTo(xe, H);
    g.stroke();
    g.fillStyle = '#26d65a';
    g.fillRect(xs - 2, 0, 4, H); g.fillRect(xe - 2, 0, 4, H);
    if (this.previewSrc) {
      const t = this.previewStart + (this.engine.ctx.currentTime - this.previewT0);
      g.fillStyle = '#fff';
      g.fillRect((t / dur) * W, 0, 1.5, H);
    }
    this.updateDur();
  }

  bindTrim() {
    const c = this.cv;
    let drag = null;
    const tAt = (e) => {
      const r = c.getBoundingClientRect();
      const dur = this.take.channels[0].length / this.take.sampleRate;
      return Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
    };
    c.addEventListener('pointerdown', (e) => {
      const t = tAt(e);
      drag = Math.abs(t - this.st.start) < Math.abs(t - this.st.end) ? 'start' : 'end';
      c.setPointerCapture(e.pointerId);
      move(e);
    });
    const move = (e) => {
      if (!drag) return;
      const t = tAt(e);
      if (drag === 'start') this.st.start = Math.min(t, this.st.end - 0.5);
      else this.st.end = Math.max(t, this.st.start + 0.5);
      this.drawWave();
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('pointercancel', () => { drag = null; });
  }

  takeBuffer() {
    if (!this.take._buf) {
      const t = this.take;
      const b = this.engine.ctx.createBuffer(2, t.channels[0].length, t.sampleRate);
      b.copyToChannel(t.channels[0], 0);
      b.copyToChannel(t.channels[1], 1);
      this.take._buf = b;
    }
    return this.take._buf;
  }
  preview() {
    const ctx = this.engine.ctx;
    this.engine.resume();
    const s = ctx.createBufferSource();
    s.buffer = this.takeBuffer();
    s.connect(ctx.destination);
    s.start(0, this.st.start, this.st.end - this.st.start);
    this.previewSrc = s;
    this.previewStart = this.st.start;
    this.previewT0 = ctx.currentTime;
    this.prevBtn.textContent = '■ PARAR';
    s.onended = () => { if (this.previewSrc === s) this.stopPreview(); };
    const tick = () => { if (!this.previewSrc) return; this.drawWave(); this.raf = requestAnimationFrame(tick); };
    tick();
  }
  stopPreview() {
    if (this.previewSrc) { try { this.previewSrc.stop(); } catch (e) { /* noop */ } }
    this.previewSrc = null;
    if (this.prevBtn) this.prevBtn.textContent = '▶ OUVIR';
    this.drawWave();
  }

  // final processed audio
  render() {
    const { start, end, fadeIn, fadeOut, normalize, target } = this.st;
    const sr = this.take.sampleRate;
    const s0 = Math.floor(start * sr), s1 = Math.floor(end * sr);
    const n = s1 - s0;
    const out = this.take.channels.map((ch) => ch.slice(s0, s1));
    const fi = Math.min(n, Math.floor(fadeIn * sr)), fo = Math.min(n, Math.floor(fadeOut * sr));
    for (const ch of out) {
      for (let i = 0; i < fi; i++) ch[i] *= Math.sin((i / fi) * Math.PI / 2) ** 2;
      for (let i = 0; i < fo; i++) ch[n - 1 - i] *= Math.sin((i / fo) * Math.PI / 2) ** 2;
    }
    if (normalize) {
      let peak = 0;
      for (const ch of out) for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
      if (peak > 1e-5) {
        const g = Math.pow(10, target / 20) / peak;
        for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= g;
      }
    }
    return out;
  }

  meta() {
    return {
      title: this.st.title, artist: this.st.artist, album: this.st.album, year: this.st.year,
      genre: this.st.genre, comment: this.st.comment, bpm: this.take.bpm,
      cover: this.st.cover, coverMime: 'image/jpeg',
    };
  }

  async export(btn) {
    if (btn.disabled) return;
    const f = FORMATS[this.st.format];
    btn.disabled = true;
    this.prog.classList.add('on');
    this.progBar.style.width = '5%';
    try {
      localStorage.setItem(META_KEY, JSON.stringify({ artist: this.st.artist, album: this.st.album, genre: this.st.genre, format: this.st.format }));
    } catch (e) { /* noop */ }
    try {
      await new Promise((r) => setTimeout(r, 30));
      const audio = this.render();
      let bytes, mime;
      if (f.ext === 'wav') {
        bytes = encodeWav(audio, this.take.sampleRate, f.bits, this.meta());
        mime = 'audio/wav';
        this.progBar.style.width = '90%';
      } else {
        bytes = await encodeMp3(audio, this.take.sampleRate, f.kbps, this.meta(), (p) => { this.progBar.style.width = `${5 + p * 90}%`; });
        mime = 'audio/mpeg';
      }
      const base = safeName(this.st.artist ? `${this.st.artist} - ${this.st.title}` : this.st.title);
      const res = await saveFile(`${base}.${f.ext}`, bytes, mime);
      this.progBar.style.width = '100%';
      if (res && res.ok) {
        this.take.exported = true;
        this.take.title = this.st.title;
        this.take.cover = this.st.cover;
        setDirty(this.app.takes.some((t) => !t.exported));
        toast(`Exportado: ${res.path || base}`, 'ok', 4500);
      }
    } catch (e) {
      console.error(e);
      toast(`Erro ao exportar: ${e.message || e}`, 'err', 5000);
    } finally {
      btn.disabled = false;
      setTimeout(() => { this.prog.classList.remove('on'); this.progBar.style.width = '0'; }, 800);
    }
  }

  sendToDeck(i) {
    const audio = this.render();
    const ctx = this.engine.ctx;
    const b = ctx.createBuffer(2, audio[0].length, this.take.sampleRate);
    b.copyToChannel(audio[0], 0);
    b.copyToChannel(audio[1], 1);
    const deck = this.app.decks[i];
    if (deck.playing && !confirm(`O deck ${'ABCD'[i]} está tocando. Substituir?`)) return;
    this.app.loadBuffer(deck, b, { name: this.st.title || this.take.name, bpm: this.take.bpm });
    this.close();
  }

  // ---------------------------------------------------------------- cover art
  async setCoverFromFile(file) {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = c.height = 1000;
      const g = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 1000, 1000);
      URL.revokeObjectURL(url);
      await this.setCoverCanvas(c);
    } catch (e) {
      toast('Imagem inválida', 'err');
    }
  }
  async setCoverCanvas(c) {
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    this.st.cover = new Uint8Array(await blob.arrayBuffer());
    this.showCover();
  }
  showCover() {
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.coverUrl = URL.createObjectURL(new Blob([this.st.cover], { type: 'image/jpeg' }));
    this.coverImg.style.backgroundImage = `url(${this.coverUrl})`;
  }
  async saveCover() {
    if (!this.st.cover) return;
    const res = await saveFile(`${safeName(this.st.title)} - cover.jpg`, this.st.cover, 'image/jpeg');
    if (res && res.ok) toast('Capa salva', 'ok');
  }
  async generateCover() {
    const S = 1000;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const rnd = Math.random;
    const palettes = [
      ['#d62d20', '#f2b705', '#1f9d55', '#120d08'],
      ['#1f9d55', '#f2b705', '#d62d20', '#0b0b0b'],
      ['#f2b705', '#d62d20', '#1f9d55', '#140c06'],
      ['#e8e1d0', '#d62d20', '#111111', '#1d1a16'],
    ];
    const [c1, c2, c3, bg] = palettes[Math.floor(rnd() * palettes.length)];
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    // sun rays
    const cx = S / 2, cy = S * 0.44;
    const rays = 24 + Math.floor(rnd() * 12);
    for (let i = 0; i < rays; i++) {
      const a0 = (i / rays) * Math.PI * 2, a1 = ((i + 0.5) / rays) * Math.PI * 2;
      g.fillStyle = [c1, c2, c3][i % 3];
      g.globalAlpha = 0.85;
      g.beginPath(); g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a0) * S * 1.2, cy + Math.sin(a0) * S * 1.2);
      g.lineTo(cx + Math.cos(a1) * S * 1.2, cy + Math.sin(a1) * S * 1.2);
      g.fill();
    }
    g.globalAlpha = 1;
    // speaker box
    const R = S * 0.27;
    g.fillStyle = '#16120e';
    g.fillRect(cx - R * 1.25, cy - R * 1.25, R * 2.5, R * 2.5);
    g.strokeStyle = c2; g.lineWidth = 10;
    g.strokeRect(cx - R * 1.25, cy - R * 1.25, R * 2.5, R * 2.5);
    const ring = (r, col, w) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.strokeStyle = col; g.lineWidth = w; g.stroke(); };
    const grd = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
    grd.addColorStop(0, '#4a4038'); grd.addColorStop(1, '#0d0b09');
    g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    ring(R, '#2b2520', 18); ring(R * 0.78, '#000', 3); ring(R * 0.55, '#000', 2);
    const dg = g.createRadialGradient(cx - 10, cy - 10, 5, cx, cy, R * 0.28);
    dg.addColorStop(0, '#6b5f55'); dg.addColorStop(1, '#141110');
    g.fillStyle = dg; g.beginPath(); g.arc(cx, cy, R * 0.28, 0, Math.PI * 2); g.fill();
    // stripe band
    const bandY = S * 0.8;
    [c1, c2, c3].forEach((col, i) => { g.fillStyle = col; g.fillRect(0, bandY + i * 14, S, 14); });
    g.fillStyle = bg; g.fillRect(0, bandY + 42, S, S - bandY - 42);
    // text
    await document.fonts.ready;
    g.textAlign = 'center';
    g.fillStyle = '#f4ecd8';
    let title = (this.st.title || 'DUB').toUpperCase();
    let size = 96;
    g.font = `700 ${size}px Oswald, Impact, sans-serif`;
    while (g.measureText(title).width > S * 0.9 && size > 30) { size -= 4; g.font = `700 ${size}px Oswald, Impact, sans-serif`; }
    g.fillText(title, cx, S * 0.968);
    g.font = '500 34px Oswald, Impact, sans-serif';
    g.fillStyle = c2;
    g.fillText((this.st.artist || 'DUB-MIXER SOUND').toUpperCase(), cx, bandY + 84);
    await this.setCoverCanvas(c);
  }
}
