// Binary assets bundled into the page; only main.js imports this. See docs/web.md, Bundled assets.
import study from './env_study.hdr';
import studio from './env_studio.hdr';
import maple from './board_maple.jpg';
import walnut from './board_walnut.jpg';
import frame from './board_frame.jpg';

export const ASSETS = {
  hdr: { room: study, studio },
  wood: { maple, walnut, frame },
};
