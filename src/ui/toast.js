let box;
export function toast(msg, kind = 'info', ms = 2800) {
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

// Text input dialog (window.prompt is not available in Electron).
export function askText(title, value = '') {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ask"><h2></h2><input type="text" /><div class="ask-btns"><button class="btn sm" data-a="cancel" type="button">CANCELAR</button><button class="btn sm c-gold" data-a="ok" type="button">OK</button></div></div>`;
    back.querySelector('h2').textContent = title;
    const input = back.querySelector('input');
    input.value = value;
    document.body.appendChild(back);
    input.focus();
    input.select();
    const done = (v) => { back.remove(); resolve(v); };
    back.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (a) done(a.dataset.a === 'ok' ? input.value.trim() || null : null);
      else if (e.target === back) done(null);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
  });
}
