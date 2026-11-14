// assets/index.js -- the binary assets the page ships inside its bundle (build.mjs loaders: .jpg -> data URL,
// .hdr -> Uint8Array). Imported by main.js ONLY: the node test runner cannot import binary files, so the
// modules that use these (scene.js, materials.js) take them through their options and fall back without them.
//
//   env_study.hdr                     the Room: a study at night rendered in Blender (../../blender/room_hdri.py),
//                                     1024x512 RGBE.
//   env_studio.hdr                    CC0 HDRI by Greg Zaal / Poly Haven ("studio_small_01"), as bundled with
//                                     Blender (datafiles/studiolights/world), 512x256 RGBE.
//   board_*.jpg                       maple / walnut / frame woods baked in Blender (../../blender/board_textures.py)
import study from './env_study.hdr';
import studio from './env_studio.hdr';
import maple from './board_maple.jpg';
import walnut from './board_walnut.jpg';
import frame from './board_frame.jpg';

export const ASSETS = {
  hdr: { room: study, studio },
  wood: { maple, walnut, frame },
};
