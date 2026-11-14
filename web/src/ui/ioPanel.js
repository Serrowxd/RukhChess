import { el, button, field, copyText, PIECE_GLYPHS } from './layout.js';
import { studyToYaml, encodeHash } from '../core/io.js';

const FILES = 'abcdefgh';
const ROLES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];

function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Strict UTF-8 first, then windows-1252 (many PGN databases are still cp1252). */
async function readTextFile(f) {
  if (typeof f.arrayBuffer !== 'function' || typeof TextDecoder !== 'function') return f.text();

  const bytes = new Uint8Array(await f.arrayBuffer());

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* not UTF-8 */
  }

  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Returns { el, update, getBrush, dispose }. */
export function createIoPanel({ store, actions, dialogs }) {
  const study = () => {
    const s = store.state;
    return { title: s.study.title, created: s.study.created, notes: s.study.notes, orientation: s.orientation, game: s.game };
  };

  const baseName = () => slug(store.state.study.title) || `chessboard-${(store.state.study.created || new Date().toISOString().slice(0, 10))}`;

  const toastResult = (ok, okText) => actions.toast(ok ? okText : 'Copy failed', ok ? 'ok' : 'error');

  const tryLoad = (fn, label) => {
    try {
      fn();
    } catch (e) {
      actions.toast(`${label}: ${e && e.message ? e.message : e}`, 'error');
    }
  };

  const fen = el('input', {
    type: 'text', class: 'inp mono', spellcheck: 'false', title: 'Current position (Forsyth–Edwards Notation)',
    onkeydown: e => {
      if (e.key === 'Enter') loadFen();
    }
  });

  function loadFen() {
    const v = fen.value.trim();
    if (v) tryLoad(() => actions.loadFen(v), 'FEN');
  }

  const fenRow = el('div', { class: 'row' }, fen,
    button('Load', loadFen, { small: true, title: 'Load this FEN as a new start position' }),
    button('', async () => toastResult(await copyText(store.state.game.fen()), 'FEN copied'), { small: true, icon: 'copy', title: 'Copy FEN' }));

  let pgnDirty = false;
  const pgn = el('textarea', { class: 'inp mono', rows: 6, spellcheck: 'false', placeholder: '[Event "?"]\n\n1. e4 e5 …', oninput: () => { pgnDirty = true; } });

  const pgnRow = el('div', { class: 'row wrap', style: { marginTop: '6px' } },
    button('Load', () => {
      const t = pgn.value.trim();
      if (t) tryLoad(() => {
        actions.loadPgn(t);
        pgnDirty = false;
      }, 'PGN');
    }, { small: true, title: 'Replace the study with this PGN' }),
    button('Refresh', () => {
      pgnDirty = false;
      update();
    }, { small: true, title: 'Re-read the PGN from the board' }),
    el('span', { class: 'spacer' }),
    button('Copy', async () => toastResult(await copyText(store.state.game.toPgn()), 'PGN copied'), { small: true, icon: 'copy' }),
    button('Download .pgn', () => downloadText(baseName() + '.pgn', store.state.game.toPgn(), 'application/x-chess-pgn'), { small: true }),
  );

  const yamlPaste = el('textarea', { class: 'inp mono', rows: 4, spellcheck: 'false', placeholder: 'chessboard: 1\ntitle: …\nmoves:\n  - san: e4' });

  const fileInput = el('input', {
    type: 'file', accept: '.yaml,.yml,.pgn,.txt,text/yaml,application/x-yaml', title: 'Load a .yaml study or a .pgn file',
    onchange: async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;

      try {
        const text = await readTextFile(f);
        if (/\.pgn$/i.test(f.name)) tryLoad(() => actions.loadPgn(text), 'PGN');
        else tryLoad(() => actions.loadYaml(text), 'YAML');
      } catch (err) {
        actions.toast(`Could not read ${f.name}`, 'error');
      }

      e.target.value = '';
    },
  });

  const yamlRow = el('div', { class: 'row wrap', style: { marginTop: '6px' } },
    button('Load pasted', () => {
      const t = yamlPaste.value.trim();
      if (t) tryLoad(() => {
        actions.loadYaml(t);
        yamlPaste.value = '';
      }, 'YAML');
    }, { small: true }),
    el('span', { class: 'spacer' }),
    button('Copy', async () => {
      try {
        toastResult(await copyText(studyToYaml(study())), 'YAML copied');
      } catch (e) {
        actions.toast(String(e.message || e), 'error');
      }
    }, { small: true, icon: 'copy' }),
    button('Download .yaml', () => {
      try {
        downloadText(baseName() + '.yaml', studyToYaml(study()), 'application/x-yaml');
      } catch (e) {
        actions.toast(String(e.message || e), 'error');
      }
    }, { small: true, primary: true, title: 'Export the whole study: moves, notes, arrows, evals' }),
  );

  const n960 = el('input', { type: 'number', class: 'inp mono', min: 0, max: 959, step: 1, placeholder: '0–959', title: 'Scharnagl position number (518 = the standard array)' });

  const row960 = el('div', { class: 'row' }, n960,
    button('Random', () => {
      const n = actions.newChess960();
      if (typeof n === 'number') {
        n960.value = String(n);
        actions.toast(`Chess960 #${n}`, 'info');
      }
    }, { small: true, title: 'Start a random Chess960 game' }),
    button('Start', () => {
      const raw = n960.value.trim();
      const n = raw === '' ? NaN : Number(raw);

      if (!Number.isInteger(n) || n < 0 || n > 959) {
        actions.toast('Chess960 number must be 0–959 (or press Random)', 'error');
        return;
      }

      actions.newChess960(n);
    }, { small: true, primary: true, title: 'Start this Chess960 position' }));

  const shareBtn = button('Copy share link', async () => {
    try {
      const base = (location.origin && location.origin !== 'null') ? location.origin + location.pathname : location.href.split('#')[0];
      const link = base + encodeHash(study());
      toastResult(await copyText(link), 'Link copied');
    } catch (e) {
      actions.toast(String(e.message || e), 'error');
    }
  }, { small: true, title: 'URL with the position (or the whole game) in the hash' });

  // undefined = nothing picked, null = erase, otherwise a Piece.
  let brush;
  const palButtons = new Map();
  const pal = el('div', { class: 'pal' });

  for (const color of ['white', 'black']) {
    for (const role of ROLES) {
      const key = color + ':' + role;
      const b = el('button', { type: 'button', text: PIECE_GLYPHS[color][role], title: `${color} ${role}`, 'aria-pressed': 'false', onclick: () => setBrush({ color, role }) });
      palButtons.set(key, b);
      pal.appendChild(b);
    }
  }

  const eraseBtn = el('button', { type: 'button', class: 'erase', text: 'erase', title: 'Remove pieces (or right-click a square)', 'aria-pressed': 'false', onclick: () => setBrush(null) });
  pal.appendChild(eraseBtn);

  function setBrush(p) {
    brush = (p === null && brush === null) || (p && brush && p.color === brush.color && p.role === brush.role) ? undefined : p;

    for (const [key, b] of palButtons) b.setAttribute('aria-pressed', String(!!brush && key === brush.color + ':' + brush.role));
    eraseBtn.setAttribute('aria-pressed', String(brush === null));

    store.emit('ui:setupBrush', { piece: brush === undefined ? null : brush, erase: brush === null });
  }

  const sb = el('div', { class: 'sb', role: 'grid', title: 'Click a square to place the selected piece; right-click removes' });
  const sbCells = new Map();

  function buildBoard() {
    sb.textContent = '';
    sbCells.clear();
    const flipped = store.state.orientation === 'black';

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const fileIdx = flipped ? 7 - f : f;
        const rankIdx = flipped ? r : 7 - r;
        const sq = FILES[fileIdx] + (rankIdx + 1);
        const dark = (fileIdx + rankIdx) % 2 === 0;

        const cell = el('button', {
          type: 'button', class: dark ? 'd' : 'l', title: sq, dataset: { sq },
          onclick: () => {
            if (brush === undefined) {
              actions.toast('Pick a piece from the palette first', 'info');
              return;
            }
            actions.setupPlace(sq, brush);
          },
          oncontextmenu: e => {
            e.preventDefault();
            actions.setupPlace(sq, null);
          },
        });

        sbCells.set(sq, cell);
        sb.appendChild(cell);
      }
    }
  }

  let boardOrientation = null;

  function renderBoard() {
    const s = store.state;
    if (boardOrientation !== s.orientation) {
      boardOrientation = s.orientation;
      buildBoard();
    }

    const pieces = (s.setup && s.setup.pieces) || [];
    const map = new Map(pieces.map(p => [p.square, p.piece]));

    for (const [sq, cell] of sbCells) {
      const p = map.get(sq);
      cell.textContent = '';
      if (p) cell.appendChild(el('span', { class: p.color === 'white' ? 'wp' : 'bp', text: PIECE_GLYPHS[p.color][p.role] }));
    }
  }

  const turnW = el('input', { type: 'radio', name: 'setup-turn', value: 'white', onchange: () => actions.setupTurn('white') });
  const turnB = el('input', { type: 'radio', name: 'setup-turn', value: 'black', onchange: () => actions.setupTurn('black') });
  const castling = el('input', { type: 'text', class: 'inp mono', placeholder: 'KQkq or -', title: 'Castling rights (KQkq, or file letters for Chess960)', onchange: e => actions.setupCastling(e.target.value.trim() || '-') });

  const commitBtn = button('Commit', () => {
    try {
      actions.setupCommit();
    } catch (e) {
      actions.toast(e && e.message ? e.message : String(e), 'error');
    }
  }, { primary: true, title: 'Use this position (validates: kings, pawns, side to move not giving check)' });

  const setupBlock = el('div', { class: 'setup-block' },
    el('div', { class: 'sec-h', text: 'Setup position' }),
    pal, sb,
    el('div', { class: 'row wrap', style: { marginTop: '8px' } },
      el('label', { class: 'row', title: 'Side to move' }, turnW, 'White'),
      el('label', { class: 'row', title: 'Side to move' }, turnB, 'Black'),
      el('span', { class: 'spacer' }),
      el('span', { style: { width: '110px' } }, castling),
    ),
    el('div', { class: 'row wrap', style: { marginTop: '8px' } },
      button('Clear', () => actions.setupClear(), { small: true, title: 'Empty board' }),
      button('Start position', () => actions.setupStart(), { small: true }),
      el('span', { class: 'spacer' }),
      button('Cancel', () => actions.setMode('play'), { small: true }),
      commitBtn,
    ),
  );

  const enterSetup = button('Enter setup mode', () => { actions.setMode('setup'); }, { small: true, title: 'Place pieces freely, then Commit' });

  const root = el('div', {},
    setupBlock,
    el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('span', { text: 'FEN' }), enterSetup), fenRow),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'PGN' }), pgn, pgnRow),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'YAML study' }), el('div', { class: 'row', style: { marginBottom: '6px' } }, fileInput), yamlPaste, yamlRow),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Chess960' }), row960),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Share' }), shareBtn),
  );

  function update() {
    const s = store.state;
    const setup = s.mode === 'setup';

    setupBlock.hidden = !setup;
    enterSetup.hidden = setup;

    if (document.activeElement !== fen) fen.value = s.game.fen();

    if (!pgnDirty && document.activeElement !== pgn) {
      try {
        pgn.value = s.game.toPgn();
      } catch {
        /* keep old */
      }
    }

    if (s.game.variant === 'chess960' && s.game.chess960Number != null && document.activeElement !== n960) n960.value = String(s.game.chess960Number);

    if (setup && s.setup) {
      renderBoard();
      turnW.checked = s.setup.turn === 'white';
      turnB.checked = s.setup.turn === 'black';
      if (document.activeElement !== castling) castling.value = s.setup.castling || '';
    }
  }

  return {
    el: root, update,
    getBrush: () => brush,
    dispose() { root.remove(); },
  };
}
