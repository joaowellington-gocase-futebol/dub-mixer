// Deck waveforms: scrolling zoom view + full-track overview. Colour = bass content (red -> gold -> green).

function colorFor(low) {
  // low 1 = all bass (red), mid = gold, 0 = bright (green)
  if (low > 0.55) return `rgb(${226},${Math.round(60 + (1 - low) * 160)},${40})`;
  if (low > 0.2) return `rgb(${Math.round(150 + (low - 0.2) * 220)},${Math.round(170 + (low - 0.2) * 60)},${30})`;
  return `rgb(${Math.round(40 + low * 500)},${200},${Math.round(90 - low * 200)})`;
}

function fit(c) {
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W, H };
}

export class DeckWave {
  constructor(zoomCanvas, overCanvas, deck) {
    this.zc = zoomCanvas;
    this.oc = overCanvas;
    this.deck = deck;
    this.zoomSec = 9;
    this.overCache = null;
    this.overKey = '';
    overCanvas.addEventListener('pointerdown', (e) => this._seekOverview(e));
    overCanvas.addEventListener('pointermove', (e) => { if (e.buttons) this._seekOverview(e); });
    // drag zoom view to scrub (when paused) / nudge
    let lastX = null;
    zoomCanvas.addEventListener('pointerdown', (e) => { if (!this.deck.buffer) return; lastX = e.clientX; zoomCanvas.setPointerCapture(e.pointerId); });
    zoomCanvas.addEventListener('pointermove', (e) => {
      if (lastX == null || !this.deck.buffer) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const secPerPx = this.zoomSec / zoomCanvas.clientWidth;
      if (!this.deck.playing) this.deck.seek(this.deck.position - dx * secPerPx);
    });
    const up = () => { lastX = null; };
    zoomCanvas.addEventListener('pointerup', up);
    zoomCanvas.addEventListener('pointercancel', up);
    zoomCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomSec = Math.max(2, Math.min(40, this.zoomSec * (e.deltaY > 0 ? 1.15 : 0.87)));
    }, { passive: false });
  }

  _seekOverview(e) {
    const d = this.deck;
    if (!d.buffer) return;
    const r = this.oc.getBoundingClientRect();
    d.seek(((e.clientX - r.left) / r.width) * d.duration);
  }

  _renderOverview(W, H) {
    const p = this.deck.peaks;
    const dpr = window.devicePixelRatio || 1;
    const off = document.createElement('canvas');
    off.width = Math.round(W * dpr); off.height = Math.round(H * dpr);
    const g = off.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mid = H / 2;
    const per = p.bins / W;
    for (let x = 0; x < W; x++) {
      const b0 = Math.floor(x * per), b1 = Math.max(b0 + 1, Math.floor((x + 1) * per));
      let mn = 0, mx = 0, lo = 0;
      for (let b = b0; b < b1 && b < p.bins; b++) { if (p.min[b] < mn) mn = p.min[b]; if (p.max[b] > mx) mx = p.max[b]; lo += p.low[b]; }
      lo /= (b1 - b0);
      g.fillStyle = colorFor(lo);
      g.fillRect(x, mid - mx * mid * 0.95, 1, Math.max(1, (mx - mn) * mid * 0.95));
    }
    return off;
  }

  draw() {
    const d = this.deck;
    // ---------------- zoom
    {
      const { g, W, H } = fit(this.zc);
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#0a0908';
      g.fillRect(0, 0, W, H);
      const mid = H / 2;
      if (d.peaks) {
        const p = d.peaks;
        const pos = d.position;
        const secPerPx = this.zoomSec / W;
        const playX = W * 0.38;
        const binsPerSec = p.sampleRate / p.binSize;
        // loop region
        if (d.loop) {
          const x0 = playX + (d.loop.start - pos) / secPerPx, x1 = playX + (d.loop.end - pos) / secPerPx;
          g.fillStyle = 'rgba(31,157,85,0.18)';
          g.fillRect(x0, 0, x1 - x0, H);
        }
        // beat ticks
        const bpm = d.bpm;
        if (bpm) {
          const bl = 60 / bpm;
          g.fillStyle = 'rgba(255,255,255,0.06)';
          const first = Math.floor((pos - playX * secPerPx) / bl);
          for (let k = first; k * bl < pos + (W - playX) * secPerPx; k++) {
            const x = playX + (k * bl - pos) / secPerPx;
            g.fillRect(x, 0, 1, H);
          }
        }
        for (let x = 0; x < W; x++) {
          const t = pos + (x - playX) * secPerPx;
          if (t < 0 || t > d.duration) continue;
          const b0 = Math.floor(t * binsPerSec);
          const b1 = Math.max(b0 + 1, Math.floor((t + secPerPx) * binsPerSec));
          let mn = 0, mx = 0, lo = 0, c = 0;
          for (let b = b0; b < b1 && b < p.bins; b++) { if (p.min[b] < mn) mn = p.min[b]; if (p.max[b] > mx) mx = p.max[b]; lo += p.low[b]; c++; }
          if (!c) continue;
          lo /= c;
          g.fillStyle = colorFor(lo);
          if (x < playX) g.globalAlpha = 0.55;
          g.fillRect(x, mid - mx * mid * 0.96, 1, Math.max(1, (mx - mn) * mid * 0.96));
          g.globalAlpha = 1;
        }
        // cue markers
        const mark = (t, col, label) => {
          const x = playX + (t - pos) / secPerPx;
          if (x < -10 || x > W + 10) return;
          g.fillStyle = col;
          g.fillRect(x, 0, 1.5, H);
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 7, 0); g.lineTo(x, 7); g.fill();
          if (label) { g.font = 'bold 9px Oswald, sans-serif'; g.fillText(label, x + 3, H - 3); }
        };
        mark(d.cuePoint, '#f2b705', 'CUE');
        d.hotCues.forEach((c, i) => { if (c != null) mark(c, ['#e8412c', '#f2b705', '#2fbf71', '#4aa3ff'][i], String(i + 1)); });
        // playhead
        g.fillStyle = '#fff';
        g.shadowColor = '#fff';
        g.shadowBlur = 6;
        g.fillRect(playX - 0.75, 0, 1.5, H);
        g.shadowBlur = 0;
      } else {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.font = '12px Oswald, sans-serif';
        g.textAlign = 'center';
        g.fillStyle = 'rgba(242,183,5,0.75)';
        g.font = '13px Oswald, sans-serif';
        g.fillText('＋  CLIQUE AQUI OU ARRASTE UMA MÚSICA (MP3, WAV, FLAC…)', W / 2, mid + 5);
        g.textAlign = 'left';
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(0, mid, W, 1);
      }
    }
    // ---------------- overview
    {
      const { g, W, H } = fit(this.oc);
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#0a0908';
      g.fillRect(0, 0, W, H);
      if (d.peaks) {
        const key = `${W}x${H}:${d.peaks.bins}:${d.meta && d.meta.name}`;
        if (key !== this.overKey) { this.overCache = this._renderOverview(W, H); this.overKey = key; }
        g.drawImage(this.overCache, 0, 0, W, H);
        const x = (d.position / d.duration) * W;
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(0, 0, x, H);
        if (d.loop) {
          g.fillStyle = 'rgba(31,157,85,0.35)';
          g.fillRect((d.loop.start / d.duration) * W, 0, ((d.loop.end - d.loop.start) / d.duration) * W, H);
        }
        d.hotCues.forEach((c, i) => {
          if (c == null) return;
          g.fillStyle = ['#e8412c', '#f2b705', '#2fbf71', '#4aa3ff'][i];
          g.fillRect((c / d.duration) * W, 0, 2, H);
        });
        g.fillStyle = '#fff';
        g.fillRect(x - 1, 0, 2, H);
      }
    }
  }
}
