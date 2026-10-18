// Console hardware controls: knobs, faders, sliders, LED buttons, meters + a parameter registry.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function h(tag, cls, parent, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}

// ---------------------------------------------------------------- registry
export const registry = new Map();
export function getState(filter) {
  const out = {};
  for (const [id, c] of registry) {
    if (c.persist === false) continue;
    if (filter && !filter(id)) continue;
    out[id] = c.value;
  }
  return out;
}
export function setState(state) {
  for (const id in state) {
    const c = registry.get(id);
    if (c) c.set(state[id], true);
  }
}
function register(id, c) { if (id) registry.set(id, c); }

// ---------------------------------------------------------------- drag readout
let bubble;
function showBubble(el, text) {
  if (!bubble) bubble = h('div', 'readout', document.body);
  const r = el.getBoundingClientRect();
  bubble.textContent = text;
  bubble.style.display = 'block';
  bubble.style.left = `${r.left + r.width / 2}px`;
  bubble.style.top = `${r.top - 6}px`;
}
function hideBubble() { if (bubble) bubble.style.display = 'none'; }

// ---------------------------------------------------------------- knob
export class Knob {
  constructor(parent, o) {
    this.min = o.min ?? 0;
    this.max = o.max ?? 1;
    this.def = o.def ?? o.value ?? this.min;
    this.value = o.value ?? this.def;
    this.bipolar = !!o.bipolar;
    this.format = o.format || ((v) => v.toFixed(2));
    this.onChange = o.onChange || (() => {});
    this.steps = o.steps || 0;
    this.persist = o.persist;
    this.el = h('div', `knob ${o.size || 'm'} ${o.color ? 'c-' + o.color : ''}`, parent);
    if (o.title) this.el.title = o.title;
    const body = h('div', 'knob-body', this.el);
    this.ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.ring.setAttribute('viewBox', '0 0 40 40');
    this.ring.classList.add('knob-ring');
    this.track = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.track.classList.add('ring-track');
    this.arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.arc.classList.add('ring-arc');
    this.ring.append(this.track, this.arc);
    body.appendChild(this.ring);
    this.cap = h('div', 'knob-cap', body);
    h('div', 'knob-pointer', this.cap);
    if (o.label) this.labelEl = h('label', 'knob-label', this.el, o.label);
    this.track.setAttribute('d', arcPath(-135, 135));
    this._bind(body);
    this.set(this.value, false);
    register(o.id, this);
  }
  norm(v = this.value) { return (v - this.min) / (this.max - this.min); }
  set(v, fire = true) {
    v = clamp(+v, this.min, this.max);
    if (this.steps) v = this.min + Math.round(this.norm(v) * this.steps) / this.steps * (this.max - this.min);
    this.value = v;
    const n = this.norm(v);
    const ang = -135 + n * 270;
    this.cap.style.transform = `rotate(${ang}deg)`;
    const from = this.bipolar ? 0 : -135;
    this.arc.setAttribute('d', Math.abs(ang - from) < 0.5 ? '' : arcPath(Math.min(from, ang), Math.max(from, ang)));
    if (fire) this.onChange(v);
  }
  _bind(body) {
    let startY, startX, startV, dragging = false;
    body.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      body.setPointerCapture(e.pointerId);
      startY = e.clientY; startX = e.clientX; startV = this.norm();
      dragging = true;
      this.el.classList.add('active');
      showBubble(this.el, this.format(this.value));
    });
    body.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const fine = e.shiftKey ? 0.2 : 1;
      const d = ((startY - e.clientY) + (e.clientX - startX) * 0.5) / 180 * fine;
      this.set(this.min + clamp(startV + d, 0, 1) * (this.max - this.min));
      showBubble(this.el, this.format(this.value));
    });
    const end = () => { dragging = false; this.el.classList.remove('active'); hideBubble(); };
    body.addEventListener('pointerup', end);
    body.addEventListener('pointercancel', end);
    body.addEventListener('lostpointercapture', end);
    body.addEventListener('dblclick', () => { this.set(this.def); });
    body.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = (this.steps ? 1 / this.steps : 0.02) * (e.shiftKey ? 0.25 : 1);
      this.set(this.min + clamp(this.norm() + (e.deltaY < 0 ? step : -step), 0, 1) * (this.max - this.min));
      showBubble(this.el, this.format(this.value));
      clearTimeout(this._wt);
      this._wt = setTimeout(hideBubble, 700);
    }, { passive: false });
  }
}

function arcPath(a0, a1) {
  const r = 17, cx = 20, cy = 20;
  const p = (a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// ---------------------------------------------------------------- vertical fader
export class Fader {
  constructor(parent, o) {
    this.min = o.min ?? 0;
    this.max = o.max ?? 1;
    this.def = o.def ?? o.value ?? 0.8;
    this.value = o.value ?? this.def;
    this.format = o.format || ((v) => v.toFixed(2));
    this.onChange = o.onChange || (() => {});
    this.persist = o.persist;
    this.el = h('div', `fader ${o.cls || ''}`, parent);
    this.slot = h('div', 'fader-slot', this.el);
    const scale = h('div', 'fader-scale', this.el);
    (o.marks || ['+6', '0', '-5', '-10', '-20', '-30', '-∞']).forEach((m) => h('span', '', scale, m));
    this.cap = h('div', `fader-cap ${o.capColor || ''}`, this.el);
    if (o.label) h('label', 'fader-label', this.el, o.label);
    this._bind();
    register(o.id, this);
    requestAnimationFrame(() => this.set(this.value, false));
  }
  norm(v = this.value) { return (v - this.min) / (this.max - this.min); }
  set(v, fire = true) {
    v = clamp(+v, this.min, this.max);
    this.value = v;
    const travel = this.el.clientHeight - this.cap.offsetHeight;
    this.cap.style.transform = `translateY(${(1 - this.norm()) * Math.max(0, travel)}px)`;
    if (fire) this.onChange(v);
  }
  _bind() {
    let startY, startV, dragging = false;
    const down = (e) => {
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      dragging = true;
      startY = e.clientY;
      if (e.target !== this.cap) {
        // jump to clicked position
        const r = this.el.getBoundingClientRect();
        const travel = r.height - this.cap.offsetHeight;
        const n = 1 - (e.clientY - r.top - this.cap.offsetHeight / 2) / travel;
        this.set(this.min + clamp(n, 0, 1) * (this.max - this.min));
      }
      startV = this.norm();
      this.el.classList.add('active');
      showBubble(this.cap, this.format(this.value));
    };
    this.el.addEventListener('pointerdown', down);
    this.el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const travel = this.el.clientHeight - this.cap.offsetHeight;
      const fine = e.shiftKey ? 0.25 : 1;
      this.set(this.min + clamp(startV + ((startY - e.clientY) / travel) * fine, 0, 1) * (this.max - this.min));
      showBubble(this.cap, this.format(this.value));
    });
    const end = () => { dragging = false; this.el.classList.remove('active'); hideBubble(); };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);
    this.el.addEventListener('dblclick', () => this.set(this.def));
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.set(this.min + clamp(this.norm() + (e.deltaY < 0 ? 0.02 : -0.02), 0, 1) * (this.max - this.min));
    }, { passive: false });
    new ResizeObserver(() => this.set(this.value, false)).observe(this.el);
  }
}

// ---------------------------------------------------------------- horizontal slider (pitch)
export class HSlider {
  constructor(parent, o) {
    this.min = o.min ?? -1;
    this.max = o.max ?? 1;
    this.def = o.def ?? 0;
    this.value = o.value ?? this.def;
    this.format = o.format || ((v) => v.toFixed(2));
    this.onChange = o.onChange || (() => {});
    this.persist = o.persist;
    this.el = h('div', `hslider ${o.cls || ''}`, parent);
    h('div', 'hslider-track', this.el);
    h('div', 'hslider-center', this.el);
    this.cap = h('div', 'hslider-cap', this.el);
    this._bind();
    register(o.id, this);
    requestAnimationFrame(() => this.set(this.value, false));
  }
  norm(v = this.value) { return (v - this.min) / (this.max - this.min); }
  set(v, fire = true) {
    v = clamp(+v, this.min, this.max);
    this.value = v;
    const travel = this.el.clientWidth - this.cap.offsetWidth;
    this.cap.style.transform = `translateX(${this.norm() * Math.max(0, travel)}px)`;
    if (fire) this.onChange(v);
  }
  _bind() {
    let startX, startV, dragging = false;
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      dragging = true;
      startX = e.clientX;
      startV = this.norm();
      showBubble(this.cap, this.format(this.value));
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const travel = this.el.clientWidth - this.cap.offsetWidth;
      const fine = e.shiftKey ? 0.1 : 1;
      this.set(this.min + clamp(startV + ((e.clientX - startX) / travel) * fine, 0, 1) * (this.max - this.min));
      showBubble(this.cap, this.format(this.value));
    });
    const end = () => { dragging = false; hideBubble(); };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);
    this.el.addEventListener('dblclick', () => this.set(this.def));
    new ResizeObserver(() => this.set(this.value, false)).observe(this.el);
  }
}

// ---------------------------------------------------------------- buttons
// mode: 'push' (click), 'toggle' (latching, registered), 'hold' (momentary)
export class Btn {
  constructor(parent, o) {
    this.mode = o.mode || 'push';
    this.value = !!o.value;
    this.onChange = o.onChange || (() => {});
    this.persist = o.persist ?? (this.mode === 'toggle' ? undefined : false);
    this.el = h('button', `btn ${o.color ? 'c-' + o.color : ''} ${o.cls || ''}`, parent);
    this.el.type = 'button';
    this.el.tabIndex = -1;
    this.el.addEventListener('mousedown', (e) => e.preventDefault()); // never steal keyboard focus
    if (o.led !== false && this.mode !== 'push') h('span', 'led', this.el);
    this.labelEl = h('span', 'btn-label', this.el, o.label || '');
    if (o.title) this.el.title = o.title;
    if (o.key) this.el.dataset.key = o.key;
    this._bind();
    if (this.mode === 'toggle') register(o.id, this);
    this.render();
  }
  label(t) { this.labelEl.textContent = t; }
  render() { this.el.classList.toggle('on', this.value); }
  set(v, fire = true) {
    v = !!v;
    const changed = v !== this.value;
    this.value = v;
    this.render();
    if (fire && (changed || this.mode === 'push')) this.onChange(v);
  }
  press() {
    if (this.mode === 'push') { this.el.classList.add('flash'); setTimeout(() => this.el.classList.remove('flash'), 120); this.onChange(true); }
    else if (this.mode === 'toggle') this.set(!this.value);
    else this.set(true);
  }
  release() { if (this.mode === 'hold') this.set(false); }
  _bind() {
    if (this.mode === 'hold') {
      let held = false;
      this.el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.el.setPointerCapture(e.pointerId);
        held = true;
        this.set(true);
      });
      const up = () => { if (held) { held = false; this.set(false); } };
      this.el.addEventListener('pointerup', up);
      this.el.addEventListener('pointercancel', up);
      this.el.addEventListener('lostpointercapture', up);
      this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    } else {
      this.el.addEventListener('click', () => this.press());
    }
  }
}

// ---------------------------------------------------------------- select (stepped choice shown as LCD)
export class Choice {
  constructor(parent, o) {
    this.options = o.options;
    this.labels = o.labels || null; // optional display names for option values
    this.value = o.value ?? o.options[0];
    this.onChange = o.onChange || (() => {});
    this.persist = o.persist;
    this.el = h('div', `choice ${o.cls || ''}`, parent);
    if (o.label) h('label', 'choice-label', this.el, o.label);
    const row = h('div', 'choice-row', this.el);
    const prev = h('button', 'choice-arrow', row, '‹');
    this.lcd = h('div', 'lcd choice-lcd', row);
    const next = h('button', 'choice-arrow', row, '›');
    prev.type = next.type = 'button';
    prev.onclick = () => this.step(-1);
    next.onclick = () => this.step(1);
    this.lcd.onclick = () => this.step(1);
    register(o.id, this);
    this.set(this.value, false);
  }
  step(d) {
    const i = this.options.indexOf(this.value);
    this.set(this.options[(i + d + this.options.length) % this.options.length]);
  }
  set(v, fire = true) {
    if (!this.options.includes(v)) return;
    this.value = v;
    this.lcd.textContent = (this.labels && this.labels[v]) || v;
    if (fire) this.onChange(v);
  }
}

// ---------------------------------------------------------------- LED meter
export class Meter {
  constructor(parent, o = {}) {
    this.el = h('canvas', `meter ${o.cls || ''}`, parent);
    this.channels = o.channels || 1;
    this.segments = o.segments || 22;
    this.peak = new Array(this.channels).fill(0);
    this.hold = new Array(this.channels).fill(0);
    this.holdT = new Array(this.channels).fill(0);
    this.lvl = new Array(this.channels).fill(0);
  }
  update(levels) {
    const c = this.el;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const n = this.segments;
    const gap = 1.5;
    const segH = (H - gap * (n - 1)) / n;
    const colW = (W - (this.channels - 1) * 2) / this.channels;
    const now = performance.now();
    for (let ch = 0; ch < this.channels; ch++) {
      const raw = levels[ch] || 0;
      const db = raw > 0 ? 20 * Math.log10(raw) : -90;
      const target = clamp((db + 48) / 54, 0, 1); // -48 dB .. +6 dB
      this.lvl[ch] = target > this.lvl[ch] ? target : this.lvl[ch] * 0.9 + target * 0.1 - 0.008;
      if (this.lvl[ch] < 0) this.lvl[ch] = 0;
      if (target >= this.hold[ch] || now - this.holdT[ch] > 1200) { this.hold[ch] = target; this.holdT[ch] = now; }
      const lit = Math.round(this.lvl[ch] * n);
      const holdSeg = Math.round(this.hold[ch] * n) - 1;
      const x = ch * (colW + 2);
      for (let s = 0; s < n; s++) {
        const y = H - (s + 1) * segH - s * gap;
        const frac = s / n;
        const col = frac > 0.885 ? '#ff2b1c' : frac > 0.72 ? '#ffc21a' : '#26d65a';
        const on = s < lit || s === holdSeg;
        g.fillStyle = on ? col : 'rgba(255,255,255,0.06)';
        if (on) { g.shadowColor = col; g.shadowBlur = 4; } else g.shadowBlur = 0;
        g.fillRect(x, y, colW, segH);
      }
      g.shadowBlur = 0;
    }
  }
}

// format helpers
export const fmt = {
  db: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
  pct: (v) => `${Math.round(v * 100)}%`,
  bip: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`),
  hz: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`),
  sec: (v) => `${v.toFixed(2)} s`,
  ms: (v) => `${Math.round(v)} ms`,
};
