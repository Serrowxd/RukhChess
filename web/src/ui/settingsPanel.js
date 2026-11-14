import { el, button, field, toggleRow, segmented } from './layout.js';
import { THEME_PALETTES } from '../three/materials.js';
import { listSets, registerGltfSet } from '../three/pieces.js';
import * as piecesMod from '../three/pieces.js';
import { KEY_ROWS, MOUSE_ROWS } from './keys.js';
import { QUALITY_LEVELS, normalizeQuality } from '../core/store.js';

const PALETTE_KEYS = ['light', 'dark', 'frame', 'white', 'black'];
const ARROW_KEYS = ['green', 'red', 'blue', 'yellow'];

const TOGGLES = [
  ['showLegalMoves', 'Legal moves', 'Dots on the squares a selected piece can go to (L)'],
  ['showCoordinates', 'Coordinates', 'File and rank labels on the frame'],
  ['showLastMove', 'Last move', 'Tint the from/to squares of the last move'],
  ['showCheck', 'Check', 'Glow on a king in check'],
  ['showEngineArrow', 'Engine arrow', 'Draw the engine’s best move'],
  ['showNotes3D', '3D notes', 'Float the move note as a card over the board'],
  ['showEvalBar', 'Eval bar', 'Vertical evaluation bar beside the panel'],
  ['animations', 'Animations', 'Slide pieces when moving'],
  ['autoRotate', 'Auto-rotate', 'Slowly orbit the camera'],
];

export const LIGHTING_DEFAULTS = { preset: 'studio', on: true, exposure: 1, key: 1, ambient: 1, shadows: true, contrast: true };

const LIGHT_PRESETS = [
  { value: 'studio', label: 'Studio', title: 'The default look: key light plus a soft fill' },
  { value: 'soft', label: 'Soft', title: 'Lower key, higher ambient, gentler shadows' },
  { value: 'bright', label: 'Bright', title: 'More exposure and ambient for a lit room' },
  { value: 'flat', label: 'Flat', title: 'No shading at all — pieces read as flat silhouettes (maximum contrast)' },
];

const LIGHT_SLIDERS = [
  { key: 'exposure', label: 'Exposure', min: 0.4, max: 1.8, step: 0.01, title: 'Tone-mapping exposure — overall brightness' },
  { key: 'key', label: 'Key', min: 0, max: 2, step: 0.01, title: 'Strength of the main light (the one that casts shadows)' },
  { key: 'ambient', label: 'Ambient', min: 0, max: 2, step: 0.01, title: 'Strength of the sky / fill light' },
];

function isHex(v) { return /^#[0-9a-fA-F]{6}$/.test(String(v || '')); }

/** Returns { el, update, dispose }. */
export function createSettingsPanel({ store, actions, view, dialogs }) {
  const st = () => store.state.settings;

  const themeSeg = segmented([
    { value: 'wood', label: 'Wood' }, { value: 'metal', label: 'Metal' }, { value: 'glass', label: 'Glass' },
  ], st().theme, v => actions.setSetting('theme', v));

  const palInputs = new Map();
  const palRow = el('div', { class: 'pal-row' });

  for (const k of PALETTE_KEYS) {
    const inp = el('input', {
      type: 'color', title: `${k} colour`,
      oninput: e => {
        const cur = { ...currentPalette(), [k]: e.target.value };
        actions.setSetting('palette', cur);
      }
    });

    palInputs.set(k, inp);
    palRow.appendChild(el('label', {}, inp, el('span', { text: k })));
  }

  function currentPalette() {
    const s = st();
    const base = (THEME_PALETTES && THEME_PALETTES[s.theme]) || {};
    return { ...base, ...(s.palette || {}) };
  }

  const palReset = button('Reset to theme', () => actions.setSetting('palette', null), { small: true, title: 'Drop custom colours' });

  const setSel = el('select', { class: 'inp', title: 'Piece set', onchange: e => actions.setSetting('pieceSet', e.target.value) });
  let setIds = '';
  let setIdList = [];

  function fillSets() {
    let sets = [];
    try {
      sets = listSets() || [];
    } catch {
      sets = [];
    }

    const list = sets.map(s => s.id);
    const ids = list.join(',');
    if (ids === setIds) return;

    setIds = ids;
    setIdList = list;
    setSel.textContent = '';
    for (const s of sets) setSel.appendChild(el('option', { value: s.id, text: s.name + (s.kind === 'gltf' ? ' (glTF)' : '') }));
  }

  // glTF sets are not saved across reloads, so a stored glTF id falls back visibly.
  let warnedMissingSet = false;

  function repairPieceSet(current) {
    if (!current || !setIdList.length || setIdList.includes(current)) return current;

    const fallback = setIdList.includes('staunton') ? 'staunton' : setIdList[0];

    if (!warnedMissingSet) {
      warnedMissingSet = true;
      gltfStatus.textContent = `Piece set "${current}" is gone — glTF sets are not saved; add the file again.`;
      actions.toast('Custom glTF set is not saved across reloads — using Staunton', 'info');
    }

    actions.setSetting('pieceSet', fallback);
    return fallback;
  }

  const gltfFile = el('input', { type: 'file', accept: '.glb,.gltf,model/gltf-binary,model/gltf+json' });
  const gltfName = el('input', { type: 'text', class: 'inp', placeholder: 'My set' });
  const gltfNodes = {};
  const nodeGrid = el('div', { class: 'grid3' });

  for (const role of ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']) {
    const inp = el('input', { type: 'text', class: 'inp mono', value: role[0].toUpperCase() + role.slice(1), title: `Node name for the ${role} in the file` });
    gltfNodes[role] = inp;
    nodeGrid.appendChild(field(role, inp));
  }

  const gltfScale = el('input', { type: 'number', class: 'inp mono', value: '1', step: '0.01', min: '0.001', title: 'Uniform scale so a pawn is about 0.55 units tall' });
  const gltfKeep = toggleRow('Keep the file’s materials', false, () => {}, 'Otherwise pieces are tinted by the theme');
  const gltfStatus = el('div', { class: 'hint' });

  const gltfAdd = button('Add set', async () => {
    const f = gltfFile.files && gltfFile.files[0];
    if (!f) {
      actions.toast('Choose a .glb / .gltf file first', 'error');
      return;
    }

    const name = gltfName.value.trim() || f.name.replace(/\.(glb|gltf)$/i, '');
    const id = 'gltf-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'set') + '-' + Date.now().toString(36);

    const mapping = {};
    for (const [role, inp] of Object.entries(gltfNodes)) mapping[role] = inp.value.trim();
    const scale = Number(gltfScale.value) || 1;

    gltfAdd.disabled = true;
    gltfStatus.textContent = 'Loading…';

    try {
      await registerGltfSet({ id, name, file: f, mapping, scale, keepMaterials: !!gltfKeep.input.checked });
      setIds = '';
      fillSets();
      actions.setSetting('pieceSet', id);
      gltfStatus.textContent = `Added "${name}".`;
      actions.toast(`Piece set "${name}" added`, 'ok');
      gltfForm.open = false;
    } catch (e) {
      gltfStatus.textContent = `Failed: ${e && e.message ? e.message : e}`;
      actions.toast('Could not load the glTF set', 'error');
    } finally {
      gltfAdd.disabled = false;
    }
  }, { small: true, primary: true });

  const gltfForm = el('details', { class: 'fold' },
    el('summary', {}, el('span', { class: 'lbl', style: { margin: 0 }, text: 'Add glTF set…' })),
    el('div', { class: 'gltf-form' },
      el('div', { class: 'row', style: { marginBottom: '8px' } }, gltfFile),
      field('Name', gltfName),
      nodeGrid,
      el('div', { class: 'grid2' }, field('Scale', gltfScale), el('div', {}, gltfKeep)),
      el('div', { class: 'row' }, gltfStatus, el('span', { class: 'spacer' }), gltfAdd),
    ),
  );

  const viewSeg = segmented([
    { value: '3d', label: '3D', title: 'Sculpted pieces, free orbit (V)' },
    { value: '2d', label: '2D', title: 'Flat tokens, locked top-down (V)' },
  ], store.state.viewMode === '2d' ? '2d' : '3d', v => {
    if (typeof actions.setViewMode === 'function') actions.setViewMode(v);
    else actions.toast('2D / 3D mode is not available in this build', 'error');
  });

  const set2dSel = el('select', { class: 'inp', title: 'Piece set used in 2D mode', onchange: e => actions.setSetting('pieceSet2d', e.target.value) });
  let set2dIds = '';

  function sets2d() {
    // Read through the namespace import so an older pieces.js without it still bundles.
    const declared = piecesMod && Array.isArray(piecesMod.BUILTIN_SETS_2D) ? piecesMod.BUILTIN_SETS_2D : null;
    if (declared && declared.length) return declared.map(s => (typeof s === 'string' ? { id: s, name: s } : s));

    let all = [];
    try {
      all = listSets() || [];
    } catch {
      all = [];
    }

    const flat = all.filter(s => /glyph|flat|token|2d/i.test(s.id + ' ' + (s.name || '')));
    return flat.length ? flat : all;
  }

  function fill2dSets() {
    const list = sets2d();
    const ids = list.map(s => s.id).join(',');
    if (ids === set2dIds) return;

    set2dIds = ids;
    set2dSel.textContent = '';
    for (const s of list) set2dSel.appendChild(el('option', { value: s.id, text: s.name || s.id }));
  }

  const lighting = () => ({ ...LIGHTING_DEFAULTS, ...(st().lighting || {}) });

  // three/scene.js resolves a preset; its numbers are then adopted back into settings.
  const lightPresetSeg = segmented(LIGHT_PRESETS, lighting().preset, v => {
    actions.setSetting('lighting.preset', v);

    requestAnimationFrame(() => {
      const res = view && view.lighting;
      if (!res || typeof res !== 'object') return;

      for (const spec of LIGHT_SLIDERS) {
        const rv = res[spec.key];
        if (Number.isFinite(rv) && rv !== lighting()[spec.key]) actions.setSetting('lighting.' + spec.key, rv);
      }
    });
  });

  const lightOn = toggleRow('Lighting on', true, v => actions.setSetting('lighting.on', v), 'Off renders every piece and square at its own colour with no shading — the highest-contrast reading');

  // settings.shadows mirrors lighting.shadows, so both are written.
  const shadowsSw = toggleRow('Shadows', true, v => {
    actions.setSetting('lighting.shadows', v);
    actions.setSetting('shadows', v);
  }, 'Soft shadows (costs a little GPU)');

  const contrastSw = toggleRow('Piece contrast', true, v => actions.setSetting('lighting.contrast', v), 'Darker piece edge plus a contact shadow so a white piece never merges into a light square');
  const qualityOptions = QUALITY_LEVELS.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
  const qualitySeg = segmented(qualityOptions, normalizeQuality(st().quality), v => actions.setSetting('quality', v));

  // Sliders preview live, coalesced to one setSetting per animation frame.
  const sliders = new Map();
  const sliderBox = el('div', {});

  for (const spec of LIGHT_SLIDERS) {
    const valText = document.createTextNode('1.00');
    const label = el('span', { class: 'lbl' }, spec.label + ' ', el('span', { class: 'mono sl-val' }, valText));
    let pending = null, raf = 0;

    const flush = () => {
      raf = 0;
      if (pending == null) return;

      const v = pending;
      pending = null;
      actions.setSetting('lighting.' + spec.key, v);
    };

    const input = el('input', {
      type: 'range', min: spec.min, max: spec.max, step: spec.step, title: spec.title,
      oninput: e => {
        const v = Number(e.target.value);
        valText.nodeValue = v.toFixed(2);
        pending = v;
        if (!raf) raf = requestAnimationFrame(flush);
      },
      onchange: e => {
        pending = Number(e.target.value);
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        flush();
      },
    });

    const cancel = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
    };

    sliders.set(spec.key, { input, valText, cancel });
    sliderBox.appendChild(el('div', { class: 'field sl' }, label, input));
  }

  const lightReset = button('Reset lighting', () => {
    for (const [k, v] of Object.entries(LIGHTING_DEFAULTS)) actions.setSetting('lighting.' + k, v);
    actions.setSetting('shadows', LIGHTING_DEFAULTS.shadows);
  }, { small: true, title: 'Back to the Studio defaults' });

  const spRotate = toggleRow('Rotate the board', true, v => actions.setSetting('selfPlay.rotate', v), 'Self-play: turn the board to the other seat as an animation instead of flipping instantly');
  const spAutoFlip = toggleRow('Change seats after each move', true, v => actions.setSetting('selfPlay.autoFlip', v), 'Self-play: off keeps you on one side of the board');

  const toggles = new Map();
  const toggleBox = el('div', {});

  for (const [path, label, title] of TOGGLES) {
    const row = toggleRow(label, !!st()[path], v => actions.setSetting(path, v), title);
    toggles.set(path, row);
    toggleBox.appendChild(row);
  }

  const arrowInputs = new Map();
  const arrowRow = el('div', { class: 'arrow-row' });

  for (const k of ARROW_KEYS) {
    const inp = el('input', { type: 'color', title: `${k} arrows / highlights`, oninput: e => actions.setSetting('arrowColors.' + k, e.target.value) });
    arrowInputs.set(k, inp);
    arrowRow.appendChild(el('label', {}, inp, el('span', { text: k })));
  }

  const uiSeg = segmented([
    { value: 'auto', label: 'Auto', title: 'Follow the system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
  ], st().uiTheme, v => actions.setSetting('uiTheme', v));

  const bgAuto = el('input', { type: 'checkbox', onchange: e => actions.setSetting('background', e.target.checked ? 'auto' : (isHex(bgColor.value) ? bgColor.value : '#ECEBE6')) });

  const bgColor = el('input', {
    type: 'color', title: 'Scene background',
    oninput: e => {
      bgAuto.checked = false;
      actions.setSetting('background', e.target.value);
    }
  });

  const bgRow = el('div', { class: 'row' }, el('label', { class: 'row', title: 'Use the page background' }, bgAuto, 'Auto'), bgColor);

  const envSeg = segmented([
    { value: 'room', label: 'Room', title: 'A warm room behind the board, which stands on a walnut table' },
    { value: 'studio', label: 'Studio', title: 'A neutral studio behind the board, on the walnut table' },
    { value: 'plain', label: 'Plain', title: 'No room: the board on the page background' },
  ], st().environment || 'room', v => actions.setSetting('environment', v));

  const camRow = el('div', { class: 'row wrap' },
    ...['white', 'black', 'top', 'side'].map(p => button(p[0].toUpperCase() + p.slice(1), () => view && view.setPreset && view.setPreset(p), { small: true, title: `Camera: ${p}` })),
  );

  const resetAll = button('Reset all settings', async () => {
    const ok = dialogs ? await dialogs.confirm('Reset every setting to its default? (Your study and the saved API key are kept.)', { ok: 'Reset', danger: true }) : true;
    if (ok) actions.resetSettings();
  }, { small: true, danger: true });

  const keyTable = el('table', { class: 'keys' }, el('tbody', {},
    ...KEY_ROWS.map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', { text: k })), el('td', { text: d }))),
    ...MOUSE_ROWS.map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', { text: k })), el('td', { text: d }))),
  ));

  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', text });

  // Hidden until the browser names the graphics adapter.
  const gpuLine = el('p', { hidden: true });

  const about = el('div', { class: 'about' },
    el('p', {}, 'Rukh — a 3D chessboard you can share with an AI. Free software, GPL v3.'),
    el('p', {}, 'Engine: Stockfish 19 (Chess.com build of Stockfish), GPLv3 — ', link('https://github.com/nmrugg/stockfish.js', 'stockfish.js'), ' · ', link('https://github.com/official-stockfish/Stockfish', 'Stockfish source'), '.'),
    el('p', {}, 'Piece glyphs: cburnett, CC BY-SA 3.0. Rendering: Three.js (MIT). Rules, FEN, PGN, Chess960: chessops (GPLv3). YAML: js-yaml (MIT).'),
    gpuLine,
  );

  const root = el('div', {},
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Board' }),
      field('View', viewSeg),
      field('Setting', envSeg),
      field('Theme', themeSeg),
      el('div', { class: 'field' }, el('div', { class: 'sec-h' }, el('span', { text: 'Palette' }), palReset), palRow),
      field('Piece set (3D)', setSel), field('Piece set (2D)', set2dSel), gltfForm),
    el('div', { class: 'sec' },
      el('div', { class: 'sec-h' }, el('span', { text: 'Lighting' }), lightReset),
      field('Preset', lightPresetSeg),
      lightOn,
      sliderBox,
      shadowsSw, contrastSw,
      field('Quality', qualitySeg)),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Self-play' }), spRotate, spAutoFlip),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Display' }), toggleBox),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Arrow colours' }), arrowRow),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Interface' }), field('UI theme', uiSeg), field('Background', bgRow)),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Camera' }), camRow),
    el('div', { class: 'sec' }, resetAll),
    el('div', { class: 'sec' }, el('details', { class: 'fold' }, el('summary', {}, el('span', { class: 'lbl', style: { margin: 0 }, text: 'Keyboard & mouse' })), keyTable)),
    el('div', { class: 'sec' }, el('details', { class: 'fold' }, el('summary', {}, el('span', { class: 'lbl', style: { margin: 0 }, text: 'About' })), about)),
  );

  function update() {
    const s = st();

    themeSeg.set(s.theme);
    const pal = currentPalette();
    for (const [k, inp] of palInputs) if (document.activeElement !== inp && isHex(pal[k])) inp.value = pal[k];
    palReset.disabled = !s.palette;

    fillSets();
    const pieceSet = repairPieceSet(s.pieceSet);
    if (pieceSet && setSel.value !== pieceSet) setSel.value = pieceSet;

    viewSeg.set(store.state.viewMode === '2d' ? '2d' : '3d');
    fill2dSets();

    const want2d = s.pieceSet2d || 'glyph';
    if (set2dSel.value !== want2d) {
      const has = Array.from(set2dSel.options).some(o => o.value === want2d);
      set2dSel.value = has ? want2d : (set2dSel.options[0] ? set2dSel.options[0].value : '');
    }

    const lz = lighting();
    lightPresetSeg.set(lz.preset);
    lightOn.input.checked = lz.on !== false;

    const shadowsOn = lz.shadows !== undefined ? !!lz.shadows : !!s.shadows;
    shadowsSw.input.checked = shadowsOn;
    contrastSw.input.checked = lz.contrast !== false;
    qualitySeg.set(normalizeQuality(s.quality));

    const flat = lz.on === false || lz.preset === 'flat';
    shadowsSw.classList.toggle('muted', flat);

    for (const spec of LIGHT_SLIDERS) {
      const sl = sliders.get(spec.key);
      if (!sl || document.activeElement === sl.input) continue;

      const raw = lz[spec.key];
      const v = Number.isFinite(raw) ? Math.max(spec.min, Math.min(spec.max, raw)) : LIGHTING_DEFAULTS[spec.key];
      const str = String(v);
      if (sl.input.value !== str) sl.input.value = str;
      sl.input.disabled = lz.on === false;

      const txt = v.toFixed(2);
      if (sl.valText.nodeValue !== txt) sl.valText.nodeValue = txt;
    }

    const sp = s.selfPlay || {};
    spRotate.input.checked = sp.rotate !== false;
    spAutoFlip.input.checked = sp.autoFlip !== false;

    for (const [path, row] of toggles) row.input.checked = !!s[path];

    const ac = s.arrowColors || {};
    for (const [k, inp] of arrowInputs) if (document.activeElement !== inp && isHex(ac[k])) inp.value = ac[k];

    uiSeg.set(s.uiTheme || 'auto');

    {
      // view.stats.gpu can change after a lost context comes back.
      const gpu = view && view.stats && view.stats.gpu;
      const text = typeof gpu === 'string' && gpu ? `Graphics: ${gpu}` : '';
      if (gpuLine.textContent !== text) gpuLine.textContent = text;
      gpuLine.hidden = !text;
    }

    envSeg.set(s.environment || 'room');

    const auto = !s.background || s.background === 'auto';
    bgAuto.checked = auto;

    if (!auto && isHex(s.background) && document.activeElement !== bgColor) bgColor.value = s.background;
    else if (auto && document.activeElement !== bgColor) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (isHex(bg)) bgColor.value = bg;
    }
  }

  return {
    el: root, update,
    dispose() {
      for (const sl of sliders.values()) sl.cancel();
      root.remove();
    },
  };
}
