// Factory style presets (global FX + master voicing). Values use control-registry IDs.
const base = {
  'echo.div': '1/4D', 'echo.feedback': 0.5, 'echo.tone': 0, 'echo.wow': 0.15, 'echo.drive': 0.3,
  'echo.spread': 0.4, 'echo.return': 0.9, 'echo.torev': 0.25,
  'spring.decay': 2.4, 'spring.drip': 0.55, 'spring.tone': 0, 'spring.return': 1.0,
  'phaser.on': false, 'phaser.rate': 0.25, 'phaser.depth': 0.7, 'phaser.center': 0.5, 'phaser.feedback': 0.3, 'phaser.mix': 0.5,
  'master.sub': 0, 'master.low': 0, 'master.pres': 0, 'master.air': 0, 'master.glue': 0.2,
  'master.filter': 0, 'master.res': 0.2,
};

export const STYLE_PRESETS = {
  'INIT / CLEAN': { ...base, 'echo.wow': 0, 'echo.drive': 0.1, 'master.glue': 0, 'siren.preset': 'CLASSIC' },
  "TUBBY'S HI-FI": {
    ...base, 'echo.div': '1/4D', 'echo.feedback': 0.56, 'echo.tone': -0.25, 'echo.wow': 0.25, 'echo.drive': 0.4,
    'echo.spread': 0.25, 'echo.torev': 0.35, 'spring.decay': 2.9, 'spring.drip': 0.8, 'spring.tone': -0.1,
    'spring.return': 1.1, 'master.sub': 3, 'master.pres': -1, 'master.air': -2.5, 'master.glue': 0.3, 'siren.preset': 'CLASSIC',
  },
  'SCIENTIST': {
    ...base, 'echo.div': '1/8D', 'echo.feedback': 0.62, 'echo.tone': 0.1, 'echo.wow': 0.1, 'echo.drive': 0.25,
    'echo.spread': 0.6, 'spring.decay': 2.0, 'spring.drip': 0.5, 'phaser.on': true, 'phaser.mix': 0.3,
    'phaser.rate': 0.15, 'master.sub': 2, 'master.air': -1, 'siren.preset': 'LASER',
  },
  'BLACK ARK': {
    ...base, 'echo.div': '1/4', 'echo.feedback': 0.66, 'echo.tone': -0.55, 'echo.wow': 0.55, 'echo.drive': 0.7,
    'echo.torev': 0.45, 'spring.decay': 3.6, 'spring.drip': 0.9, 'spring.tone': -0.35, 'spring.return': 1.2, 'phaser.on': true,
    'phaser.mix': 0.6, 'phaser.rate': 0.32, 'phaser.depth': 0.9, 'phaser.feedback': 0.55, 'phaser.center': 0.45,
    'master.pres': 1, 'master.air': -4, 'master.glue': 0.45, 'siren.preset': 'SPACESHIP',
  },
  'ARIWA DIGITAL': {
    ...base, 'echo.div': '1/4D', 'echo.feedback': 0.6, 'echo.tone': 0.35, 'echo.wow': 0, 'echo.drive': 0.08,
    'echo.spread': 0.85, 'spring.decay': 1.7, 'spring.drip': 0.3, 'spring.tone': 0.3, 'phaser.on': true,
    'phaser.mix': 0.2, 'master.sub': 2, 'master.air': 2, 'siren.preset': 'WARBLE',
  },
  'SOUND SYSTEM': {
    ...base, 'echo.div': '1/2', 'echo.feedback': 0.5, 'echo.tone': -0.45, 'echo.wow': 0.2, 'echo.drive': 0.45,
    'spring.decay': 2.2, 'spring.drip': 0.6, 'master.sub': 6, 'master.low': 2, 'master.pres': -2, 'master.air': -3,
    'master.glue': 0.5, 'siren.preset': 'DEEP SIREN',
  },
  'UK STEPPERS': {
    ...base, 'echo.div': '1/8', 'echo.feedback': 0.45, 'echo.tone': 0.2, 'echo.wow': 0.05, 'echo.drive': 0.3,
    'echo.spread': 0.7, 'spring.decay': 1.4, 'spring.drip': 0.35, 'master.sub': 4, 'master.air': 1.5,
    'master.glue': 0.4, 'siren.preset': 'ALARM',
  },
  'LOVERS ROCK': {
    ...base, 'echo.div': '1/4', 'echo.feedback': 0.35, 'echo.tone': 0.05, 'echo.wow': 0.1, 'spring.decay': 2.6,
    'spring.drip': 0.4, 'spring.tone': 0.2, 'master.sub': 1, 'master.air': 1, 'master.glue': 0.25, 'siren.preset': 'BIRD',
  },
  'DIGI DANCEHALL': {
    ...base, 'echo.div': '1/16', 'echo.feedback': 0.3, 'echo.tone': 0.4, 'echo.wow': 0, 'echo.drive': 0.15,
    'spring.decay': 1.0, 'spring.drip': 0.2, 'master.sub': 5, 'master.pres': 2, 'master.glue': 0.45, 'siren.preset': 'RISER',
  },
};

const KEY = 'dubmixer.userPresets.v1';
export function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
}
export function saveUserPresets(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); return true; } catch (e) { return false; }
}
