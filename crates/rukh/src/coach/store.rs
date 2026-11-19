//! The only code that touches `<data dir>/coach/` on disk. Every call blocks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

use rukh_coach::batch::{
    batch_id, batch_number, game_file_number, game_id, game_number, sort, BatchRecord, Part,
    Summary, Undone, BATCH_VERSION, RAW_PART,
};
use rukh_coach::defaults::{PERSONA, SOUL};
use rukh_coach::game::{clear_side, game_text, give_side};
use rukh_coach::keys::Keys;
use rukh_coach::profile::{
    add_names, default_profile, load_profile, my_names, profile_text, remove_names,
};
use rukh_coach::skip::Skipped;
use rukh_coach::state::State;
use rukh_coach::text::TextGame;
use rukh_coach::time::utc_text;
use rukh_coach::version::Loaded;
use serde::Serialize;
use serde_json::Value;

use crate::hub::Hub;
use crate::safe::{self, NewFailure};

/// Tries at a free name before a write-once file gives up.
const MAX_NAME_TRIES: usize = 1000;

/// Why a coach call stored nothing, or not everything.
#[derive(Debug)]
pub enum Failure {
    NoGames,
    TooManyGames,
    UnknownBatch,
    /// The program is stopping.
    Closed,
    /// A file was written by a newer Rukh, so nothing is written here.
    Newer(String),
    Io(String),
}

/// Something the person should know that did not stop the call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct Imported {
    #[serde(flatten)]
    pub summary: Summary,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<Notice>,
    /// Set when a write failed part way; what landed before it is kept.
    #[serde(skip)]
    pub failed: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UndoAnswer {
    pub batch: String,
    pub moved: usize,
    pub already_undone: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<Notice>,
}

#[derive(Debug, Serialize)]
pub struct NamesAnswer {
    pub names: Vec<String>,
    /// Stored games whose side these names made known.
    pub given_side: usize,
    /// Stored games whose side was forgotten with a removed name.
    pub cleared_side: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<Notice>,
}

pub struct Store {
    data_dir: PathBuf,
    root: PathBuf,
    state: State,
    keys: Keys,
    hub: Arc<Hub>,
    notices: Vec<Notice>,
}

/// The reason in an I/O error, without the code Windows adds.
fn reason(text: &str) -> String {
    let text = text.split(" (os error").next().unwrap_or(text);
    text.trim().trim_end_matches('.').to_string()
}

fn io_text(what: &str, e: &io::Error) -> String {
    format!("Could not {what}: {}.", reason(&e.to_string()))
}

/// Paths a test makes fail as a file or folder that cannot be looked at.
#[cfg(test)]
pub static HIDDEN: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

#[cfg(test)]
fn look(path: &Path) -> io::Result<()> {
    let hidden = HIDDEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if hidden.contains(path) {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(())
}

#[cfg(not(test))]
fn look(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// The game number in a file name, temp and set-aside copies included, so an id is never reused.
fn number_on_disk(name: &str) -> Option<u64> {
    let end = name.find(".json")? + ".json".len();
    game_file_number(&name[..end])
}

fn newer_text(shown: &str, version: u64) -> String {
    format!("{shown} was written by a newer Rukh (version {version}), so nothing is stored here.")
}

impl Store {
    pub fn open(data_dir: &Path, hub: Arc<Hub>, now_ms: u64) -> Result<Store, Failure> {
        let root = data_dir.join("coach");

        let mut store = Store {
            data_dir: data_dir.to_path_buf(),
            root,
            state: State::default(),
            keys: Keys::new(),
            hub,
            notices: Vec::new(),
        };

        store.refuse_newer()?;

        for dir in ["games", "imports", "derived"] {
            fs::create_dir_all(store.path(dir))
                .map_err(|e| Failure::Io(io_text(&format!("make coach/{dir}"), &e)))?;
        }

        store.write_if_missing("persona.md", PERSONA.as_bytes())?;
        store.write_if_missing("soul.md", SOUL.as_bytes())?;
        store.profile(now_ms)?;

        store.set_temp_files_aside()?;
        store.load_state(now_ms)?;
        store.load_keys(now_ms)?;
        Ok(store)
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn shown(&self, path: &Path) -> String {
        path.strip_prefix(&self.data_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    fn notice(&mut self, code: &'static str, message: String) {
        self.notices.push(Notice { code, message });
    }

    fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    /// A version above the program's in any file it rewrites leaves the folder untouched.
    fn refuse_newer(&self) -> Result<(), Failure> {
        let version = |relative: &str| -> Option<u64> {
            let text = fs::read_to_string(self.path(relative)).ok()?;
            match relative {
                "profile.json" => newer_of(load_profile(&text)),
                "state.json" => newer_of(State::loaded(&text)),
                _ => newer_of(Keys::loaded(&text)),
            }
        };

        for relative in ["profile.json", "state.json", "derived/keys.json"] {
            if let Some(v) = version(relative) {
                return Err(Failure::Newer(newer_text(&format!("coach/{relative}"), v)));
            }
        }
        Ok(())
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> Result<(), Failure> {
        self.hub.note_write();

        safe::write(path, bytes).map_err(|e| {
            Failure::Io(format!(
                "Could not save {}: {}.",
                self.shown(path),
                reason(&e.reason())
            ))
        })
    }

    /// Writes a file that must not exist yet; `Ok(false)` when something is already there.
    fn write_new(&self, path: &Path, bytes: &[u8]) -> Result<bool, Failure> {
        self.hub.note_write();

        match safe::write_new(path, bytes) {
            Ok(()) => Ok(true),
            Err(NewFailure::Exists) => Ok(false),
            Err(NewFailure::Failed(e)) => Err(Failure::Io(io_text(
                &format!("save {}", self.shown(path)),
                &e,
            ))),
        }
    }

    /// Writes a default only where nothing is; a file that cannot be looked at refuses the call.
    fn write_if_missing(&self, relative: &str, bytes: &[u8]) -> Result<(), Failure> {
        let path = self.path(relative);

        match look(&path).and_then(|()| fs::symlink_metadata(&path)) {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(Failure::Io(io_text(&format!("read coach/{relative}"), &e))),
        }

        self.write_new(&path, bytes).map(|_| ())
    }

    /// Every file name in a folder; an absent folder has none, and any other error refuses the call.
    fn names_in(&self, dir: &Path) -> Result<Vec<String>, Failure> {
        let failed = |e: &io::Error| Failure::Io(io_text(&format!("list {}", self.shown(dir)), e));

        let entries = match look(dir).and_then(|()| fs::read_dir(dir)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(failed(&e)),
        };

        let mut names = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| failed(&e))?;
            names.push(entry.file_name().to_string_lossy().into_owned());
        }

        names.sort();
        Ok(names)
    }

    /// Moves a file that will not parse to `broken/`, never over another, and says so.
    fn set_aside(&mut self, relative: &str, now_ms: u64) -> Result<(), Failure> {
        let from = self.path(relative);
        let name = relative.replace('/', "-");

        self.hub.note_write();
        let moved = safe::move_aside(&from, &self.path("broken"), now_ms, |n| {
            format!("{name}.{n}")
        })
        .map_err(|e| Failure::Io(io_text(&format!("move {} aside", self.shown(&from)), &e)))?;

        let message =
            format!("coach/{relative} could not be read. It was moved to coach/broken/{moved}.");
        self.notice("set_aside", message);
        Ok(())
    }

    /// The profile; a missing one is made, one that does not read is set aside and replaced.
    fn profile(&mut self, now_ms: u64) -> Result<Value, Failure> {
        let path = self.path("profile.json");

        match fs::read_to_string(&path) {
            Ok(text) => match load_profile(&text) {
                Loaded::Read(profile) => return Ok(profile),
                Loaded::Newer(v) => {
                    return Err(Failure::Newer(newer_text("coach/profile.json", v)))
                }
                Loaded::Unreadable => self.set_aside("profile.json", now_ms)?,
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                self.set_aside("profile.json", now_ms)?
            }
            Err(e) => return Err(Failure::Io(io_text("read coach/profile.json", &e))),
        }

        let profile = default_profile();
        self.write(&path, profile_text(&profile).as_bytes())?;
        Ok(profile)
    }

    /// Temp files of writes a stopped program never finished go to `broken/` under their own names.
    fn set_temp_files_aside(&mut self) -> Result<(), Failure> {
        let mut dirs = vec![self.root.clone(), self.path("games"), self.path("derived")];
        for batch in self.names_in(&self.path("imports"))? {
            dirs.push(self.path("imports").join(batch));
        }

        let broken = self.path("broken");
        let mut moved = 0;

        for dir in dirs {
            for name in self
                .names_in(&dir)?
                .into_iter()
                .filter(|n| safe::is_temp_file(n))
            {
                self.hub.note_write();

                let to_name = |n: u64| match n {
                    0 => name.clone(),
                    n => format!("{name}.{n}"),
                };
                safe::move_aside(&dir.join(&name), &broken, 0, to_name)
                    .map_err(|e| Failure::Io(io_text(&format!("move {name} aside"), &e)))?;
                moved += 1;
            }
        }

        if moved > 0 {
            let message = format!(
                "{moved} unfinished temp file(s) from a stopped Rukh were moved to coach/broken/."
            );
            self.notice("temp_files", message);
        }
        Ok(())
    }

    /// Game files in `games/`, by number.
    fn game_files(&self) -> Result<BTreeMap<u64, String>, Failure> {
        let names = self.names_in(&self.path("games"))?;

        Ok(names
            .into_iter()
            .filter_map(|name| Some((game_file_number(&name)?, name)))
            .collect())
    }

    fn game_bytes(&self, name: &str) -> io::Result<Vec<u8>> {
        let path = self.path("games").join(name);

        look(&path)?;
        fs::read(&path)
    }

    fn read_game(&self, name: &str) -> Option<Value> {
        let bytes = self.game_bytes(name).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn highest_on_disk(&self) -> Result<(u64, u64), Failure> {
        let mut games: Vec<String> = self.names_in(&self.path("games"))?;
        games.extend(self.names_in(&self.path("broken"))?);
        for batch in self.names_in(&self.path("removed"))? {
            games.extend(self.names_in(&self.path("removed").join(batch))?);
        }

        let game = games.iter().filter_map(|n| number_on_disk(n)).max();
        let batch = self
            .names_in(&self.path("imports"))?
            .iter()
            .filter_map(|n| batch_number(n))
            .max();

        Ok((game.unwrap_or(0), batch.unwrap_or(0)))
    }

    /// Reads the counters and raises them above every id on disk.
    fn load_state(&mut self, now_ms: u64) -> Result<(), Failure> {
        let path = self.path("state.json");

        let read = match fs::read_to_string(&path) {
            Ok(text) => match State::loaded(&text) {
                Loaded::Read(state) => Some(state),
                Loaded::Newer(v) => return Err(Failure::Newer(newer_text("coach/state.json", v))),
                Loaded::Unreadable => {
                    self.set_aside("state.json", now_ms)?;
                    None
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                self.set_aside("state.json", now_ms)?;
                None
            }
            Err(e) => return Err(Failure::Io(io_text("read coach/state.json", &e))),
        };

        let found = read.is_some();
        self.state = read.unwrap_or_default();

        let (game, batch) = self.highest_on_disk()?;
        if self.state.raise(game, batch) || !found {
            self.write(&path, self.state.to_text().as_bytes())?;
        }
        Ok(())
    }

    /// Reads the duplicate index and brings it in line with `games/`; rebuilds it when missing.
    fn load_keys(&mut self, now_ms: u64) -> Result<(), Failure> {
        let path = self.path("derived/keys.json");

        let read = match fs::read_to_string(&path) {
            Ok(text) => match Keys::loaded(&text) {
                Loaded::Read(keys) => Some(keys),
                Loaded::Newer(v) => {
                    return Err(Failure::Newer(newer_text("coach/derived/keys.json", v)))
                }
                Loaded::Unreadable => {
                    self.set_aside("derived/keys.json", now_ms)?;
                    None
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                self.set_aside("derived/keys.json", now_ms)?;
                None
            }
            Err(e) => return Err(Failure::Io(io_text("read coach/derived/keys.json", &e))),
        };

        let rebuilt = read.is_none();
        let mut keys = read.unwrap_or_else(Keys::new);
        let before = keys.clone();

        let files = self.game_files()?;
        let ids: BTreeSet<String> = files.keys().map(|n| game_id(*n)).collect();
        keys.keep(|id| ids.contains(id));

        let indexed: BTreeSet<u64> = keys
            .moves
            .values()
            .filter_map(|id| game_number(id))
            .collect();
        let mut unreadable = 0;

        for (number, name) in &files {
            let unknown = rebuilt || *number >= keys.covers_below || !indexed.contains(number);
            if !unknown {
                continue;
            }

            // A file that cannot be read may hold a stored game, so its key is never left out.
            let bytes = match self.game_bytes(name) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => {
                    let text = io_text(&format!("read coach/games/{name}"), &e);
                    return Err(Failure::Io(text));
                }
            };

            let file = serde_json::from_slice::<Value>(&bytes).ok();
            let added = file.is_some_and(|file| keys.add_file(&file));
            unreadable += usize::from(!added);
        }

        keys.covers_below = self.state.next_game;
        self.keys = keys;

        if unreadable > 0 {
            let message = format!(
                "{unreadable} game file(s) in coach/games could not be read; they are left as they are."
            );
            self.notice("unreadable_games", message);
        }

        if rebuilt || self.keys != before {
            self.write(&path, self.keys.to_text().as_bytes())?;
        }
        Ok(())
    }

    /// True when an earlier batch kept exactly these bytes.
    fn raw_kept(&self, bytes: &[u8]) -> Result<bool, Failure> {
        let batches = self.names_in(&self.path("imports"))?;

        Ok(batches.into_iter().any(|batch| {
            let raw = self.path("imports").join(batch).join(RAW_PART);
            let same_size = fs::metadata(&raw).is_ok_and(|m| m.len() == bytes.len() as u64);

            same_size && fs::read(&raw).is_ok_and(|kept| kept == bytes)
        }))
    }

    /// Takes a batch id and writes the raw text under it, passing over any id already in use.
    fn new_batch(&mut self, bytes: &[u8]) -> Result<(String, PathBuf), Failure> {
        for _ in 0..MAX_NAME_TRIES {
            let Some(number) = self.state.take_batch() else {
                break;
            };
            let batch = batch_id(number);

            let folder = self.path("imports").join(&batch);
            if folder.exists() {
                continue;
            }

            fs::create_dir_all(&folder)
                .map_err(|e| Failure::Io(io_text(&format!("make coach/imports/{batch}"), &e)))?;
            if self.write_new(&folder.join(RAW_PART), bytes)? {
                return Ok((batch, folder));
            }
        }

        Err(Failure::Io(
            "Could not find a free import number.".to_string(),
        ))
    }

    /// Writes one game under the next free id; `None` when no id is left.
    fn write_game(
        &mut self,
        mut text_of: impl FnMut(&str) -> String,
    ) -> Result<Option<String>, Failure> {
        for _ in 0..MAX_NAME_TRIES {
            let Some(number) = self.state.take_game() else {
                return Ok(None);
            };
            let id = game_id(number);

            let path = self.path("games").join(format!("{id}.json"));
            if self.write_new(&path, text_of(&id).as_bytes())? {
                return Ok(Some(id));
            }
        }

        Ok(None)
    }

    /// Stores the new games of one text, in an order a kill cannot spoil.
    pub fn import_text(
        &mut self,
        bytes: &[u8],
        games: Vec<TextGame>,
        skipped: Skipped,
        now_ms: u64,
    ) -> Result<Imported, Failure> {
        let profile = self.profile(now_ms)?;
        let sorted = sort(games, skipped, &self.keys, &my_names(&profile));
        let mut summary = sorted.summary;

        // Skipped games and games matched without a date live only in this text.
        let only_here = summary.skipped_total > 0 || summary.already_here_undated > 0;
        let keep_raw = !sorted.new.is_empty() || (only_here && !self.raw_kept(bytes)?);

        if !keep_raw {
            return Ok(Imported {
                summary,
                notices: self.take_notices(),
                failed: None,
            });
        }

        let (batch, folder) = self.new_batch(bytes)?;

        let mut added = Vec::new();
        let mut set_up = 0;
        let mut failed = None;

        for mut record in sorted.new {
            record.source.batch = batch.clone();

            let written = self.write_game(|id| {
                record.id = id.to_string();
                record.to_text()
            });
            let id = match written {
                Ok(Some(id)) => id,
                Ok(None) => {
                    failed = Some("The game numbers are used up.".to_string());
                    break;
                }
                Err(Failure::Io(text)) => {
                    failed = Some(text);
                    break;
                }
                Err(other) => return Err(other),
            };

            self.keys
                .add(&id, &record.move_key, record.source.site_key.as_deref());
            set_up += u32::from(record.from_position);
            added.push(id);
        }

        let state_written = self.write(&self.path("state.json"), self.state.to_text().as_bytes());

        self.keys.covers_below = self.state.next_game;
        let keys_written = self.write(
            &self.path("derived/keys.json"),
            self.keys.to_text().as_bytes(),
        );

        let record = BatchRecord {
            v: BATCH_VERSION,
            id: batch.clone(),
            kind: "text".to_string(),
            received: Some(utc_text(now_ms)),
            parts: vec![Part {
                name: RAW_PART.to_string(),
                bytes: bytes.len() as u64,
            }],
            added: added.clone(),
            already_here: summary.already_here,
            skipped: summary.skipped,
            undone: None,
            extra: BTreeMap::new(),
        };
        let batch_written = self.write(&folder.join("batch.json"), record.to_text().as_bytes());

        for written in [state_written, keys_written, batch_written] {
            if let (None, Err(Failure::Io(text))) = (&failed, written) {
                failed = Some(text);
            }
        }

        summary.batch = Some(batch);
        summary.added = added.len() as u32;
        summary.set_up = set_up;

        Ok(Imported {
            summary,
            notices: self.take_notices(),
            failed,
        })
    }

    fn batch_record(&mut self, batch: &str, now_ms: u64) -> Result<Option<BatchRecord>, Failure> {
        let relative = format!("imports/{batch}/batch.json");
        let shown = format!("coach/{relative}");

        match fs::read_to_string(self.path(&relative)) {
            Ok(text) => match BatchRecord::loaded(&text) {
                Loaded::Read(record) => Ok(Some(record)),
                Loaded::Newer(v) => Err(Failure::Newer(newer_text(&shown, v))),
                Loaded::Unreadable => {
                    self.set_aside(&relative, now_ms)?;
                    Ok(None)
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                self.set_aside(&relative, now_ms)?;
                Ok(None)
            }
            Err(e) => Err(Failure::Io(io_text(&format!("read {shown}"), &e))),
        }
    }

    /// Moves a batch's game files to `removed/<batch>/`; the raw text stays and nothing is deleted.
    pub fn undo(&mut self, batch: &str, now_ms: u64) -> Result<UndoAnswer, Failure> {
        let folder = self.path("imports").join(batch);
        if batch_number(batch).is_none() || !folder.is_dir() {
            return Err(Failure::UnknownBatch);
        }

        let files = self.game_files()?;
        let record = self.batch_record(batch, now_ms)?;
        if record.as_ref().is_some_and(|r| r.undone.is_some()) {
            return Ok(UndoAnswer {
                batch: batch.to_string(),
                moved: 0,
                already_undone: true,
                notices: self.take_notices(),
            });
        }

        let removed = self.path("removed").join(batch);
        let mut moved = 0;
        let mut failed = None;

        for name in files.into_values() {
            let Some(file) = self.read_game(&name) else {
                continue;
            };

            let of_batch = file
                .get("source")
                .and_then(|s| s.get("batch"))
                .and_then(Value::as_str)
                == Some(batch);
            if !of_batch {
                continue;
            }

            if let Err(e) = fs::create_dir_all(&removed) {
                failed = Some(io_text(&format!("make coach/removed/{batch}"), &e));
                break;
            }

            self.hub.note_write();
            if let Err(e) = fs::rename(self.path("games").join(&name), removed.join(&name)) {
                failed = Some(io_text(&format!("move coach/games/{name}"), &e));
                break;
            }

            self.keys.remove(name.trim_end_matches(".json"));
            moved += 1;
        }

        self.write(
            &self.path("derived/keys.json"),
            self.keys.to_text().as_bytes(),
        )?;
        if let Some(text) = failed {
            return Err(Failure::Io(text));
        }

        let mut record = record.unwrap_or_else(|| BatchRecord {
            v: BATCH_VERSION,
            id: batch.to_string(),
            kind: "text".to_string(),
            received: None,
            parts: Vec::new(),
            added: Vec::new(),
            already_here: 0,
            skipped: Default::default(),
            undone: None,
            extra: BTreeMap::new(),
        });

        let in_removed = self
            .names_in(&removed)?
            .iter()
            .filter_map(|name| game_file_number(name).map(game_id))
            .collect();
        record.undone = Some(Undone {
            at: utc_text(now_ms),
            moved: in_removed,
        });
        self.write(&folder.join("batch.json"), record.to_text().as_bytes())?;

        Ok(UndoAnswer {
            batch: batch.to_string(),
            moved,
            already_undone: false,
            notices: self.take_notices(),
        })
    }

    /// Adds and removes the player's own names, then brings every stored game's side in line.
    pub fn change_names(
        &mut self,
        add: &[String],
        remove: &[String],
        now_ms: u64,
    ) -> Result<NamesAnswer, Failure> {
        let files = self.game_files()?;
        let mut profile = self.profile(now_ms)?;
        let before = my_names(&profile);

        remove_names(&mut profile, remove);
        let list = add_names(&mut profile, add);
        if list != before {
            self.write(
                &self.path("profile.json"),
                profile_text(&profile).as_bytes(),
            )?;
        }

        let mut given_side = 0;
        let mut cleared_side = 0;

        for name in files.into_values() {
            let Some(mut file) = self.read_game(&name) else {
                continue;
            };

            let cleared = clear_side(&mut file, &list);
            let given = give_side(&mut file, &list);
            if !cleared && !given {
                continue;
            }

            let path = self.path("games").join(&name);
            self.write(&path, game_text(&file).as_bytes())?;

            match (cleared, given) {
                (true, false) => cleared_side += 1,
                (false, true) => given_side += 1,
                _ => {}
            }
        }

        Ok(NamesAnswer {
            names: list,
            given_side,
            cleared_side,
            notices: self.take_notices(),
        })
    }
}

fn newer_of<T>(loaded: Loaded<T>) -> Option<u64> {
    match loaded {
        Loaded::Newer(v) => Some(v),
        Loaded::Read(_) | Loaded::Unreadable => None,
    }
}
