// Platform abstraction: Electron (Mac/Windows), Android (Capacitor), plain web.
export const isElectron = !!window.dubNative;
export const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const platformName = isElectron ? (window.dubNative.platform === 'darwin' ? 'macOS' : 'Windows') : isNative ? 'Android' : 'Web';

function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

const FILTERS = {
  wav: [{ name: 'WAV Audio', extensions: ['wav'] }],
  mp3: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
  jpg: [{ name: 'JPEG Image', extensions: ['jpg'] }],
  json: [{ name: 'DUB-MIXER Preset', extensions: ['json'] }],
};

// returns { ok, path? , shared? }
export async function saveFile(name, bytes, mime) {
  const ext = name.split('.').pop().toLowerCase();
  if (isElectron) {
    return await window.dubNative.saveFile(name, bytes, FILTERS[ext]);
  }
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const write = async (directory, path) => {
      const STEP = 3 * 1024 * 1024; // multiple of 3 keeps base64 chunks independent
      await Filesystem.writeFile({ path, directory, data: toBase64(bytes.subarray(0, STEP)), recursive: true });
      for (let i = STEP; i < bytes.length; i += STEP) {
        await Filesystem.appendFile({ path, directory, data: toBase64(bytes.subarray(i, i + STEP)) });
      }
      return (await Filesystem.getUri({ path, directory })).uri;
    };
    let uri, where;
    try {
      uri = await write(Directory.Documents, `DUB-MIXER/${name}`);
      where = `Documentos/DUB-MIXER/${name}`;
    } catch (e) {
      uri = await write(Directory.Cache, name);
      where = null;
    }
    try { await Share.share({ title: name, files: [uri] }); } catch (e) { /* user closed share sheet */ }
    return { ok: true, path: where || name, shared: true };
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { ok: true, path: name };
}

export function setDirty(d) { if (isElectron && window.dubNative.setDirty) window.dubNative.setDirty(d); }
