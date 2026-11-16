import { el, button, field, segmented } from './layout.js';
import { aiChip, choiceFromSeats, seatsForChoice, STYLES } from '../net/remoteSync.js';

const SIDE_OPTIONS = [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }];
const OPPONENT_OPTIONS = [{ value: 'nobody', label: 'Nobody' }, { value: 'ai', label: 'AI' }];
const STYLE_LABELS = { silent: 'Silent', annotate: 'Annotate', coach: 'Coach' };

/** ui is what mountUi returned, remote the controller from startRemoteSync. Returns { update, dispose }. */
export function mountRemotePlay({ remote, ui }) {
  const chipDot = el('span', { class: 'dot' });
  const chipText = el('span', { class: 'tb-ai-text', text: '' });
  const chip = el('span', { class: 'tb-ai', role: 'status' }, chipDot, chipText);

  const bar = ui && ui.topbar && ui.topbar.el;
  if (bar) {
    const title = bar.querySelector('h1');
    bar.insertBefore(chip, title ? title.nextSibling : bar.firstChild);
  }

  let choice = { you: 'white', opponent: 'nobody' };
  let lastSeats = '';

  function choose(patch) {
    choice = { ...choice, ...patch };

    // During a match a seat change is sent at once; one that could not be sent is undone.
    if (remote.match().active) {
      if (!remote.setSeats(seatsForChoice(choice))) {
        lastSeats = '';
        update();
      }
    } else update();
  }

  const youSeg = segmented(SIDE_OPTIONS, choice.you, v => choose({ you: v }));
  const oppSeg = segmented(OPPONENT_OPTIONS, choice.opponent, v => choose({ opponent: v }));
  const styleSeg = segmented(STYLES.map(s => ({ value: s, label: STYLE_LABELS[s] })), remote.match().style, v => {
    if (!remote.setStyle(v)) update();
  });

  // Start and Stop share one button; a quiet window stops a double click doing both.
  const QUIET_MS = 400;
  let quietUntil = 0;
  const now = () => Date.now();

  const startBtn = button('Start', () => {
    const busy = typeof remote.status === 'function' && remote.status().pending > 0;
    if (busy || now() < quietUntil) return;

    quietUntil = now() + QUIET_MS;

    if (remote.match().active) remote.stopMatch();
    // No style: the program keeps the one a Style click already set.
    else remote.startMatch(seatsForChoice(choice));
  }, { primary: true });

  const tipBtn = button('Back to game', () => remote.gotoTip(), { small: true });
  const statusText = document.createTextNode('');

  const root = el('div', { class: 'sec sp rp' },
    el('div', { class: 'sec-h', text: 'Play' }),
    el('div', { class: 'hint sp-status' }, statusText),
    field('You play', youSeg),
    field('Opponent', oppSeg),
    field('Style', styleSeg),
    el('div', { class: 'row' }, startBtn, tipBtn),
  );

  // Connected, this block takes the place of the Self-play block.
  const selfPlay = ui && ui.panels && ui.panels.engine && ui.panels.engine.selfPlay;
  const oldBlock = selfPlay && selfPlay.el;

  if (oldBlock && oldBlock.parentNode) {
    oldBlock.parentNode.insertBefore(root, oldBlock);
    oldBlock.hidden = true;
  }

  let lastActive = null;

  function update() {
    const match = remote.match();
    const seatsKey = `${match.seats.white}/${match.seats.black}`;

    // Follow seats changed by the program or another view.
    if (seatsKey !== lastSeats || match.active) {
      lastSeats = seatsKey;
      choice = choiceFromSeats(match.seats, choice);
    }

    youSeg.set(choice.you);
    oppSeg.set(choice.opponent);
    styleSeg.set(match.style);

    if (lastActive !== match.active) {
      if (lastActive !== null) quietUntil = now() + QUIET_MS;
      lastActive = match.active;

      startBtn.textContent = match.active ? 'Stop' : 'Start';
      startBtn.classList.toggle('danger', match.active);
      startBtn.classList.toggle('primary', !match.active);
    }

    tipBtn.hidden = !(match.active && !match.live);

    const reachable = !(typeof remote.stopped === 'function' && remote.stopped())
      && !(typeof remote.connected === 'function' && !remote.connected());
    root.classList.toggle('rp-off', !reachable);
    root.inert = !reachable;

    const board = typeof remote.tabs === 'function' ? remote.tabs().tab : null;
    const c = aiChip(remote.presence(), match, remote.snapshot(), board);
    if (chipText.textContent !== c.text) chipText.textContent = c.text;
    chipDot.className = `dot ${c.state}`;

    const status = match.active && !match.live ? `${c.text}. Browsing` : c.text;
    if (statusText.nodeValue !== status) statusText.nodeValue = status;
  }

  const off = remote.onChange(update);
  update();

  return {
    update,
    dispose() {
      off();
      chip.remove();
      root.remove();
      if (oldBlock) oldBlock.hidden = false;
    },
  };
}
