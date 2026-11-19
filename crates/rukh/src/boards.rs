//! The saved board tabs in `<data dir>/boards/`: restore at start, the saver task, closed and broken files.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rukh_core::{
    tab_id_in_file_name, Applied, Damaged, Desk, Error, SavedIndex, SavedTab, Tab, TabId, TabKind,
    Unsaved, MAX_TAB_NUMBER, NOTHING_CLOSED,
};
use serde::Serialize;
use serde_json::json;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use crate::hub::{now_ms, Hub};
use crate::safe::{self, Lock, Locked};

/// Notes and evaluations wait this long without a further change before they are written.
const QUIET: Duration = Duration::from_secs(1);

/// Closed boards kept in `closed/`, newest first.
pub const KEEP_CLOSED: usize = 20;

/// Notices kept for pages that connect later.
const KEEP_NOTICES: usize = 20;

pub const README: &str = "\
These are your saved boards, one file per tab. index.json holds their order.
Edit them only while Rukh is closed: a running Rukh writes its own copy over yours.
A file Rukh cannot read is moved to broken/. A board you closed waits in closed/.
";

pub const INDEX_REBUILT: &str = "The list of boards was rebuilt; their order may have changed.";

/// One thing a person should be told about the saved boards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub id: u64,
    pub code: &'static str,
    pub text: String,
}

/// Whether boards are saved, the notices and the closed count; sent in the hello and on every change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Status {
    pub saving: bool,
    pub notices: Vec<Notice>,
    /// Boards `tab_reopen` can bring back: closed files whose id is not open.
    pub closed: usize,
}

impl Status {
    pub fn new(saving: bool, notices: Vec<(&'static str, String)>) -> Status {
        let mut status = Status {
            saving,
            notices: Vec::new(),
            closed: 0,
        };

        for (code, text) in notices {
            status.add(code, text);
        }
        status
    }

    pub fn add(&mut self, code: &'static str, text: String) {
        let id = self.notices.last().map_or(1, |n| n.id + 1);
        self.notices.push(Notice { id, code, text });

        let over = self.notices.len().saturating_sub(KEEP_NOTICES);
        self.notices.drain(..over);
    }

    /// The hello's `boards` object.
    pub fn boards(&self) -> serde_json::Value {
        json!({"saving": self.saving, "notices": self.notices, "closed": self.closed})
    }

    /// The `{"t":"boards",...}` message.
    pub fn message(&self) -> String {
        let mut message = self.boards();
        message["t"] = json!("boards");
        message.to_string()
    }
}

/// The folder layout under `<data dir>/boards/`.
#[derive(Debug, Clone)]
pub struct Folder {
    pub boards: PathBuf,
}

impl Folder {
    pub fn new(data_dir: &Path) -> Folder {
        Folder {
            boards: data_dir.join("boards"),
        }
    }

    pub fn closed(&self) -> PathBuf {
        self.boards.join("closed")
    }

    pub fn broken(&self) -> PathBuf {
        self.boards.join("broken")
    }

    pub fn tab_file(&self, id: TabId) -> PathBuf {
        self.boards.join(format!("{id}.json"))
    }

    pub fn index_file(&self) -> PathBuf {
        self.boards.join("index.json")
    }
}

/// What the program starts with.
pub struct Opened {
    pub desk: Desk,
    pub status: Status,
    /// Set when this program saves the boards.
    pub saving: Option<(Folder, Lock)>,
}

/// Takes the folder's lock and restores the boards; with no lock the boards live in memory.
pub async fn open(data_dir: Option<PathBuf>, port: u16, instance: &str) -> Opened {
    let memory = |notices: Vec<(&'static str, String)>| Opened {
        desk: Desk::new(instance),
        status: Status::new(false, notices),
        saving: None,
    };

    let Some(dir) = data_dir else {
        return memory(Vec::new());
    };

    let made = {
        let dir = dir.clone();
        tokio::task::spawn_blocking(move || fs::create_dir_all(dir)).await
    };
    if let Err(e) = made.map_err(io::Error::other).and_then(|r| r) {
        return memory(vec![(
            "folder_failed",
            format!(
                "Could not use the data folder {}: {e}. Boards are not being saved.",
                dir.display()
            ),
        )]);
    }

    match Lock::acquire(&dir, port, instance, now_ms()).await {
        Locked::Ours(lock) => open_locked(&dir, lock, port, instance).await,
        Locked::Held { port } => memory(vec![second_program(port)]),
        Locked::Failed(e) => memory(vec![(
            "folder_failed",
            format!("Could not lock the data folder: {e}. Boards are not being saved."),
        )]),
    }
}

/// Restores the boards under a lock just taken; saves only if the lock still names this program after.
pub async fn open_locked(dir: &Path, lock: Lock, port: u16, instance: &str) -> Opened {
    let memory = |notices: Vec<(&'static str, String)>| Opened {
        desk: Desk::new(instance),
        status: Status::new(false, notices),
        saving: None,
    };

    let folder = Folder::new(dir);
    let restored = {
        let folder = folder.clone();
        let instance = instance.to_string();
        tokio::task::spawn_blocking(move || restore(&folder, &instance, now_ms())).await
    };

    let restored = match restored.map_err(io::Error::other).and_then(|r| r) {
        Ok(restored) => restored,
        Err(e) => {
            release(lock).await;
            return memory(vec![(
                "folder_failed",
                format!(
                    "Could not use the boards folder {}: {e}. Boards are not being saved.",
                    folder.boards.display()
                ),
            )]);
        }
    };

    let owner = {
        let path = lock.path().to_path_buf();
        tokio::task::spawn_blocking(move || safe::lock_owner(&path))
            .await
            .ok()
            .flatten()
    };

    if owner.as_ref().map(|(_, id)| id.as_str()) != Some(instance) {
        let port = owner.map_or(port, |(port, _)| port);
        return memory(vec![second_program(port)]);
    }

    let mut desk = restored.desk;
    if !restored.saving {
        release(lock).await;
        desk.stop_saving();

        return Opened {
            desk,
            status: Status::new(false, restored.notices),
            saving: None,
        };
    }

    let mut status = Status::new(true, restored.notices);
    status.closed = restored.closed;

    Opened {
        desk,
        status,
        saving: Some((folder, lock)),
    }
}

fn second_program(port: u16) -> (&'static str, String) {
    (
        "second_program",
        format!(
            "Another Rukh (on port {port}) is using this data folder, so these boards are not \
             being saved."
        ),
    )
}

async fn release(lock: Lock) {
    let _ = tokio::task::spawn_blocking(move || lock.release()).await;
}

fn file_names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }

    names.sort();
    Ok(names)
}

/// `t4.json` and nothing else: temp and pending files are not tab files.
fn tab_file_id(name: &str) -> Option<TabId> {
    let id = tab_id_in_file_name(name)?;
    (name == format!("{id}.json")).then_some(id)
}

/// `t4.json.pending`, the newer copy a write could not put in place.
fn pending_file_id(name: &str) -> Option<TabId> {
    let id = tab_id_in_file_name(name)?;
    (name == format!("{id}.json.pending")).then_some(id)
}

/// A name shaped like a tab file whose number is too large to be a board id.
fn oversized_tab_file(name: &str) -> bool {
    let Some(digits) = name
        .strip_prefix('t')
        .and_then(|rest| rest.strip_suffix(".json"))
    else {
        return false;
    };

    !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0')
        && tab_file_id(name).is_none()
}

/// `t4.json.tmp-1234`, left by a program that was stopped in the middle of a write.
fn is_temp_file(name: &str) -> bool {
    name.rsplit_once(".tmp-")
        .is_some_and(|(_, pid)| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
}

/// Moves a file whole to `broken/<stem>.<ms>.json`; returns its name in `broken/`.
fn move_to_broken(folder: &Folder, from: &Path, stem: &str, now_ms: u64) -> io::Result<String> {
    let mut ms = now_ms;

    loop {
        let name = format!("{stem}.{ms}.json");
        let to = folder.broken().join(&name);

        if !to.exists() {
            fs::rename(from, &to)?;
            return Ok(name);
        }
        ms += 1;
    }
}

/// Moves temp files left by a stopped program out of the way, into `broken/`, under their own names.
fn set_temp_files_aside(folder: &Folder, dir: &Path, now_ms: u64) {
    for name in file_names(dir).unwrap_or_default() {
        if !is_temp_file(&name) {
            continue;
        }

        let mut to = folder.broken().join(&name);
        if to.exists() {
            to = folder.broken().join(format!("{name}.{now_ms}"));
        }
        let _ = fs::rename(dir.join(&name), to);
    }
}

fn broken_notice(shown: &str, why: &Damaged, moved: io::Result<String>) -> (&'static str, String) {
    moved_notice(&format!("The saved board {shown}"), &why.to_string(), moved)
}

fn moved_notice(subject: &str, why: &str, moved: io::Result<String>) -> (&'static str, String) {
    match moved {
        Ok(name) => (
            "broken",
            format!("{subject} could not be read: {why}. It was moved to broken/{name}."),
        ),
        Err(e) => (
            "broken",
            format!(
                "{subject} could not be read: {why}. It could not be moved to broken/ ({e}), so \
                 it was left as it is."
            ),
        ),
    }
}

fn text_of(bytes: Vec<u8>) -> Result<String, Damaged> {
    String::from_utf8(bytes).map_err(|_| Damaged("the file is not UTF-8 text".into()))
}

/// Reads a tab file through the core; a game stub is returned but never replayed.
fn read_tab(text: &str, named: TabId) -> Result<(SavedTab, Option<Tab>), Damaged> {
    let saved = SavedTab::from_text(text)?;

    if saved.id != named {
        return Err(Damaged(format!(
            "the file is named {named}.json but holds board {}",
            saved.id
        )));
    }

    if saved.kind() == TabKind::Game {
        return Ok((saved, None));
    }

    let tab = Tab::from_saved(&saved)?;
    Ok((saved, Some(tab)))
}

/// What reading one file of a tab gave.
enum Found {
    Loaded(SavedTab, Option<Box<Tab>>),
    Damaged(Damaged),
    Unreadable(io::Error),
}

fn read_file(path: &Path, id: TabId) -> Found {
    let text = match fs::read(path) {
        Ok(bytes) => text_of(bytes),
        Err(e) => return Found::Unreadable(e),
    };

    match text.and_then(|text| read_tab(&text, id)) {
        Ok((saved, tab)) => Found::Loaded(saved, tab.map(Box::new)),
        Err(why) => Found::Damaged(why),
    }
}

/// What reading `index.json` or its pending copy gave.
enum IndexFound {
    Loaded(SavedIndex),
    Missing,
    Damaged(Damaged),
    Unreadable(io::Error),
}

fn read_index(path: &Path) -> IndexFound {
    let text = match fs::read(path) {
        Ok(bytes) => text_of(bytes),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return IndexFound::Missing,
        Err(e) => return IndexFound::Unreadable(e),
    };

    match text.and_then(|text| SavedIndex::from_text(&text)) {
        Ok(index) => IndexFound::Loaded(index),
        Err(why) => IndexFound::Damaged(why),
    }
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// What a start found in `boards/`.
pub struct Restored {
    pub desk: Desk,
    pub notices: Vec<(&'static str, String)>,
    /// False when part of the folder cannot be used; the desk then lives in memory.
    pub saving: bool,
    /// Closed boards that can be reopened.
    pub closed: usize,
}

/// One restore, with the notices it gathers and whether files may still be moved and written.
struct Restoring<'a> {
    folder: &'a Folder,
    now_ms: u64,
    saving: bool,
    notices: Vec<(&'static str, String)>,
}

impl Restoring<'_> {
    fn to_broken(&self, from: &Path, stem: &str) -> io::Result<String> {
        if !self.saving {
            return Err(io::Error::other("the boards folder cannot be written"));
        }

        move_to_broken(self.folder, from, stem, self.now_ms)
    }

    fn damaged(&mut self, path: &Path, name: &str, stem: &str, why: &Damaged) {
        let moved = self.to_broken(path, stem);
        self.notices.push(broken_notice(name, why, moved));
    }

    /// The index from `index.json` or a newer `index.json.pending`, or `None` to rebuild it.
    fn index(&mut self) -> Option<SavedIndex> {
        let path = self.folder.index_file();
        let pending_name = "index.json.pending";
        let pending_path = safe::pending_path(&path);

        let file = read_index(&path);
        let pending = read_index(&pending_path);

        let file_is_newer = modified(&path) > modified(&pending_path);
        let file_loads = matches!(file, IndexFound::Loaded(_));

        let use_pending = match &pending {
            IndexFound::Loaded(_) => {
                safe::adopt_pending(&path);
                !file_loads || !file_is_newer
            }
            IndexFound::Damaged(why) => {
                let moved = self.to_broken(&pending_path, pending_name);
                let subject = format!("The list of boards in {pending_name}");
                self.notices
                    .push(moved_notice(&subject, &why.to_string(), moved));
                false
            }
            IndexFound::Unreadable(e) => {
                self.notices.push(unreadable(pending_name, e));
                false
            }
            IndexFound::Missing => false,
        };

        let chosen = match pending {
            IndexFound::Loaded(index) if use_pending => Some(index),
            _ => None,
        };

        let why = match file {
            IndexFound::Loaded(index) => return chosen.or(Some(index)),
            IndexFound::Missing => return chosen,
            IndexFound::Damaged(why) => why.to_string(),
            IndexFound::Unreadable(e) => e.to_string(),
        };

        self.set_index_aside(&path, &why, chosen.is_some());
        chosen
    }

    /// Moves a damaged `index.json` to `broken/`; one that cannot be moved stops the saving.
    fn set_index_aside(&mut self, path: &Path, why: &str, has_pending: bool) {
        match self.to_broken(path, "index") {
            Ok(name) if has_pending => self.notices.push(moved_notice(
                "The list of boards in index.json",
                why,
                Ok(name),
            )),
            Ok(_) => self
                .notices
                .push(("index_rebuilt", INDEX_REBUILT.to_string())),
            Err(_) => {
                self.saving = false;
                self.notices.push((
                    "index_unreadable",
                    format!(
                        "Could not read boards/index.json: {why}. It was left as it is, and \
                         boards are not being saved."
                    ),
                ));
            }
        }
    }

    /// A tab from `t4.json` or a newer `t4.json.pending`; true when it came from the pending copy.
    fn tab(&mut self, id: TabId, names: &[String]) -> Option<(Tab, bool)> {
        let name = format!("{id}.json");
        let pending_name = format!("{name}.pending");
        let path = self.folder.boards.join(&name);
        let pending_path = self.folder.boards.join(&pending_name);

        let file = names.contains(&name).then(|| read_file(&path, id));
        let pending = names
            .contains(&pending_name)
            .then(|| read_file(&pending_path, id));

        let file_is_newer = modified(&path) > modified(&pending_path);
        let file_loads = matches!(file, Some(Found::Loaded(..)));

        let use_pending = match &pending {
            Some(Found::Loaded(..)) => {
                safe::adopt_pending(&path);
                !file_loads || !file_is_newer
            }
            Some(Found::Damaged(why)) => {
                self.damaged(&pending_path, &pending_name, &pending_name, why);
                false
            }
            Some(Found::Unreadable(e)) => {
                self.notices.push(unreadable(&pending_name, e));
                false
            }
            None => false,
        };

        let file = match file {
            Some(Found::Damaged(why)) => {
                self.damaged(&path, &name, &id.to_string(), &why);
                None
            }
            Some(Found::Unreadable(e)) => {
                self.notices.push(unreadable(&name, &e));
                None
            }
            other => other,
        };

        let (chosen, from_pending) = if use_pending {
            (pending, true)
        } else {
            (file, false)
        };

        match chosen {
            Some(Found::Loaded(_, Some(tab))) => Some((*tab, from_pending)),
            Some(Found::Loaded(saved, None)) => {
                self.notices.push((
                    "coach_game",
                    format!(
                        "Board {id} (\u{ab}{}\u{bb}) is a coach game, which this Rukh cannot \
                         open yet. Its file was left as it is.",
                        saved.name
                    ),
                ));
                None
            }
            _ => None,
        }
    }
}

fn unreadable(name: &str, e: &io::Error) -> (&'static str, String) {
    (
        "unreadable",
        format!("Could not read boards/{name}: {e}. It was left as it is."),
    )
}

/// Builds the desk from `boards/`, moving what cannot be read to `broken/`. Deletes nothing.
pub fn restore(folder: &Folder, instance: &str, now_ms: u64) -> io::Result<Restored> {
    fs::create_dir_all(&folder.boards)?;

    let mut run = Restoring {
        folder,
        now_ms,
        saving: true,
        notices: Vec::new(),
    };

    for dir in [folder.closed(), folder.broken()] {
        if let Err(e) = fs::create_dir_all(&dir) {
            run.saving = false;
            run.notices.push((
                "folder_failed",
                format!(
                    "Could not use the boards folder {}: {e}. Boards are not being saved.",
                    dir.display()
                ),
            ));
        }
    }

    if run.saving {
        set_temp_files_aside(folder, &folder.boards, now_ms);
        set_temp_files_aside(folder, &folder.closed(), now_ms);
    }

    let names = file_names(&folder.boards)?;

    let mut seen: BTreeSet<TabId> = BTreeSet::new();
    for dir in [folder.closed(), folder.broken()] {
        seen.extend(
            file_names(&dir)
                .unwrap_or_default()
                .iter()
                .filter_map(|n| tab_id_in_file_name(n)),
        );
    }
    seen.extend(names.iter().filter_map(|n| tab_id_in_file_name(n)));

    let index = run.index();

    for name in names.iter().filter(|n| oversized_tab_file(n)) {
        let why = Damaged(format!(
            "its number is above t{MAX_TAB_NUMBER}, the largest a board may have"
        ));
        let stem = name.trim_end_matches(".json").to_string();
        run.damaged(&folder.boards.join(name), name, &stem, &why);
    }

    let ids: BTreeSet<TabId> = names
        .iter()
        .filter_map(|n| tab_file_id(n).or_else(|| pending_file_id(n)))
        .collect();

    let mut tabs: Vec<Tab> = Vec::new();
    let mut from_pending: Vec<TabId> = Vec::new();
    for id in &ids {
        if let Some((tab, pending)) = run.tab(*id, &names) {
            if pending {
                from_pending.push(*id);
            }
            tabs.push(tab);
        }
    }

    let found_any = !ids.is_empty()
        || names
            .iter()
            .any(|n| matches!(n.as_str(), "index.json" | "index.json.pending"));
    let mut notices = run.notices;
    let saving = run.saving;

    let readme = folder.boards.join("README.txt");
    if saving && !readme.exists() {
        let _ = safe::write(&readme, README.as_bytes());
    }

    let loaded: BTreeSet<TabId> = tabs.iter().map(Tab::id).collect();
    let game_floor = tabs
        .iter()
        .filter(|t| t.kind() == TabKind::Free)
        .map(|t| t.table().game_id().saturating_add(1))
        .max()
        .unwrap_or(1);

    let mut index = match index {
        Some(index) => {
            explain_index(&index, &loaded, &names, &mut notices);
            index
        }
        None => {
            let told = notices
                .iter()
                .any(|(code, _)| matches!(*code, "index_rebuilt" | "index_unreadable"));
            if !loaded.is_empty() && !told {
                notices.push(("index_rebuilt", INDEX_REBUILT.to_string()));
            }

            SavedIndex {
                selected: loaded.iter().next().copied(),
                order: loaded.iter().copied().collect(),
                next_game_id: game_floor,
                ..SavedIndex::default()
            }
        }
    };

    index.next_game_id = index.next_game_id.max(game_floor);
    for id in &seen {
        index.note_seen(*id);
    }

    if tabs.is_empty() && found_any {
        notices.push((
            "fresh_board",
            "No saved board could be loaded, so a fresh Board 1 was made.".to_string(),
        ));
    }

    let closed = closed_ids(folder).difference(&loaded).count();

    let mut desk = Desk::restore(instance, &index, tabs);
    for id in from_pending {
        desk.mark_to_write(id);
    }

    Ok(Restored {
        desk,
        notices,
        saving,
        closed,
    })
}

/// Notices for a readable index: entries with no file, files it does not name, a lost selection.
fn explain_index(
    index: &SavedIndex,
    loaded: &BTreeSet<TabId>,
    names: &[String],
    notices: &mut Vec<(&'static str, String)>,
) {
    for id in &index.order {
        let file = format!("{id}.json");
        let pending = format!("{file}.pending");
        if !names.contains(&file) && !names.contains(&pending) {
            notices.push((
                "missing",
                format!(
                    "Board {id} is in the list of boards, but its file {file} is missing, so it \
                     was left out."
                ),
            ));
        }
    }

    for id in loaded {
        if !index.order.contains(id) {
            notices.push((
                "added",
                format!(
                    "The saved board {id}.json was not in the list of boards, so it was added at \
                     the end."
                ),
            ));
        }
    }

    if let Some(selected) = index.selected {
        if !loaded.contains(&selected) && !loaded.is_empty() {
            notices.push((
                "selection_lost",
                "The board that was shown last time could not be loaded, so the first board is \
                 shown."
                    .to_string(),
            ));
        }
    }
}

/// What the hub sends the saver.
pub enum ToSaver {
    Changed(Unsaved),
    Reopen {
        by: String,
        intent_id: Option<u64>,
        reply: oneshot::Sender<Result<Applied, Error>>,
    },
    Finish,
}

pub type SaverSender = mpsc::UnboundedSender<ToSaver>;

/// What is waiting to be written.
#[derive(Default)]
struct Pending {
    now: BTreeSet<TabId>,
    quiet: BTreeMap<TabId, Instant>,
    index: bool,
    closed: Vec<SavedTab>,
    removed: Vec<TabId>,
    /// Closed files whose tab came back; removed once the tab is written again.
    reopened: Vec<(TabId, PathBuf)>,
}

impl Pending {
    fn merge(&mut self, unsaved: Unsaved) {
        for id in unsaved.now {
            self.quiet.remove(&id);
            self.now.insert(id);
        }

        let due = Instant::now() + QUIET;
        for id in unsaved.quiet {
            if !self.now.contains(&id) {
                self.quiet.insert(id, due);
            }
        }

        self.index |= unsaved.index;
        self.closed.extend(unsaved.closed);

        for id in unsaved.removed {
            self.now.remove(&id);
            self.quiet.remove(&id);
            self.removed.push(id);
        }
    }

    fn next_quiet(&self) -> Option<Instant> {
        self.quiet.values().min().copied()
    }

    /// Takes the tabs due now; with `all`, every quiet one too.
    fn due(&mut self, all: bool) -> BTreeSet<TabId> {
        let now = Instant::now();
        let ready: Vec<TabId> = self
            .quiet
            .iter()
            .filter(|(_, at)| all || **at <= now)
            .map(|(id, _)| *id)
            .collect();

        for id in &ready {
            self.quiet.remove(id);
        }

        let mut due = std::mem::take(&mut self.now);
        due.extend(ready);
        due
    }
}

/// One pass of writes, made with no lock held.
struct Pass {
    tabs: Vec<(TabId, SavedTab)>,
    index: Option<SavedIndex>,
    closed: Vec<SavedTab>,
    removed: Vec<TabId>,
    reopened: Vec<(TabId, PathBuf)>,
}

#[derive(Default)]
struct PassResult {
    saved: Vec<String>,
    failed_tabs: Vec<TabId>,
    index_failed: bool,
    closed_left: Vec<SavedTab>,
    removed_left: Vec<TabId>,
    reopened_left: Vec<(TabId, PathBuf)>,
    failures: Vec<(String, String)>,
    /// What `closed/` holds after a pass that wrote or removed there.
    closed_now: Option<BTreeSet<TabId>>,
}

fn closed_ms(name: &str) -> Option<u64> {
    let mut parts = name.split('.');
    parts.next()?;
    let ms = parts.next()?.parse().ok()?;
    (parts.next() == Some("json") && parts.next().is_none()).then_some(ms)
}

/// `closed/` files, newest first.
fn closed_files(folder: &Folder) -> Vec<(u64, String)> {
    let mut files: Vec<(u64, String)> = file_names(&folder.closed())
        .unwrap_or_default()
        .into_iter()
        .filter(|name| tab_id_in_file_name(name).is_some())
        .filter_map(|name| closed_ms(&name).map(|ms| (ms, name)))
        .collect();

    files.sort_by(|a, b| b.cmp(a));
    files
}

/// The ids of the boards in `closed/`, each once.
fn closed_ids(folder: &Folder) -> BTreeSet<TabId> {
    closed_files(folder)
        .iter()
        .filter_map(|(_, name)| tab_id_in_file_name(name))
        .collect()
}

fn trim_closed(folder: &Folder) {
    for (_, name) in closed_files(folder).into_iter().skip(KEEP_CLOSED) {
        let _ = fs::remove_file(folder.closed().join(name));
    }
}

fn write_closed(folder: &Folder, tab: &SavedTab, now_ms: u64) -> Result<(), safe::WriteFailure> {
    let mut ms = now_ms;
    let path = loop {
        let path = folder.closed().join(format!("{}.{ms}.json", tab.id));
        if !path.exists() {
            break path;
        }
        ms += 1;
    };

    safe::write(&path, tab.to_text().as_bytes())?;
    trim_closed(folder);
    Ok(())
}

fn run_pass(folder: &Folder, hub: &Hub, pass: Pass) -> PassResult {
    let mut result = PassResult::default();
    let mut written = BTreeSet::new();

    for (id, saved) in &pass.tabs {
        hub.note_write();
        match safe::write(&folder.tab_file(*id), saved.to_text().as_bytes()) {
            Ok(()) => {
                written.insert(*id);
                result.saved.push(format!("boards/{id}.json"));
            }
            Err(e) => {
                result.failed_tabs.push(*id);
                result
                    .failures
                    .push((format!("boards/{id}.json"), e.reason()));
            }
        }
    }

    let tabs_ok = result.failed_tabs.is_empty();
    let index_ok = match (&pass.index, tabs_ok) {
        (None, _) => true,
        (Some(_), false) => false,
        (Some(index), true) => {
            hub.note_write();
            match safe::write(&folder.index_file(), index.to_text().as_bytes()) {
                Ok(()) => {
                    result.saved.push("boards/index.json".to_string());
                    true
                }
                Err(e) => {
                    result
                        .failures
                        .push(("boards/index.json".to_string(), e.reason()));
                    false
                }
            }
        }
    };
    result.index_failed = !index_ok;

    for (id, path) in pass.reopened {
        if index_ok && written.contains(&id) {
            let _ = fs::remove_file(path);
        } else {
            result.reopened_left.push((id, path));
        }
    }

    if !index_ok {
        result.closed_left = pass.closed;
        result.removed_left = pass.removed;
        return result;
    }

    let touches_closed = !pass.closed.is_empty() || !pass.removed.is_empty();

    let mut kept_away = BTreeSet::new();
    for tab in pass.closed {
        let shown = format!("boards/closed/{}.json", tab.id);

        hub.note_write();
        match write_closed(folder, &tab, now_ms()) {
            Ok(()) => result.saved.push(shown),
            Err(e) => {
                result.failures.push((shown, e.reason()));
                kept_away.insert(tab.id);
                result.closed_left.push(tab);
            }
        }
    }

    for id in pass.removed {
        if kept_away.contains(&id) {
            result.removed_left.push(id);
            continue;
        }

        hub.note_write();
        let path = folder.tab_file(id);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => result.removed_left.push(id),
        }

        // The closed file holds everything a pending copy of ours held.
        safe::remove_pending(&path);

        // A tab reopened and closed again lives on in its newer closed file.
        result.reopened_left.retain(|(back, path)| {
            let gone = *back == id;
            if gone {
                let _ = fs::remove_file(path);
            }
            !gone
        });
    }

    if touches_closed {
        result.closed_now = Some(closed_ids(folder));
    }

    result
}

/// The newest readable closed tab whose id is not open; damaged ones go to `broken/`.
fn newest_closed(
    folder: &Folder,
    open: &BTreeSet<TabId>,
    notices: &mut Vec<(&'static str, String)>,
) -> Option<(Tab, PathBuf)> {
    for (_, name) in closed_files(folder) {
        let Some(id) = tab_id_in_file_name(&name) else {
            continue;
        };
        if open.contains(&id) {
            continue;
        }

        let path = folder.closed().join(&name);
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };

        match text_of(bytes).and_then(|text| read_tab(&text, id)) {
            Ok((_, Some(tab))) => return Some((tab, path)),
            Ok((_, None)) => continue,
            Err(why) => {
                let moved = move_to_broken(folder, &path, &id.to_string(), now_ms());
                notices.push(broken_notice(&format!("closed/{name}"), &why, moved));
            }
        }
    }

    None
}

/// The saver task: writes what the hub hands over, with no lock held while writing.
pub struct Saver {
    folder: Folder,
    hub: Arc<Hub>,
    pending: Pending,
    /// Files that failed and have been reported, until they save again.
    failing: BTreeSet<String>,
}

impl Saver {
    pub fn new(folder: Folder, hub: Arc<Hub>) -> Saver {
        Saver {
            folder,
            hub,
            pending: Pending::default(),
            failing: BTreeSet::new(),
        }
    }

    pub async fn run(
        mut self,
        mut rx: mpsc::UnboundedReceiver<ToSaver>,
        mut stopping: watch::Receiver<bool>,
    ) {
        let mut stop = *stopping.borrow();

        loop {
            let next = self.pending.next_quiet();

            tokio::select! {
                message = rx.recv() => {
                    let rest = match message {
                        Some(ToSaver::Changed(unsaved)) => {
                            self.pending.merge(unsaved);
                            self.merge_queued(&mut rx)
                        }
                        Some(other) => Some(other),
                        None => Some(ToSaver::Finish),
                    };

                    if let Some(message) = rest {
                        if self.handle(message).await {
                            return;
                        }
                    }
                },
                _ = sleep_until(next), if next.is_some() => {}
                changed = stopping.changed(), if !stop => {
                    stop = changed.is_err() || *stopping.borrow();
                }
            }

            self.flush(stop).await;
        }
    }

    /// Takes every change already queued, so a burst is written in one pass; returns the first other message.
    fn merge_queued(&mut self, rx: &mut mpsc::UnboundedReceiver<ToSaver>) -> Option<ToSaver> {
        loop {
            match rx.try_recv() {
                Ok(ToSaver::Changed(unsaved)) => self.pending.merge(unsaved),
                Ok(other) => return Some(other),
                Err(mpsc::error::TryRecvError::Empty) => return None,
                Err(mpsc::error::TryRecvError::Disconnected) => return Some(ToSaver::Finish),
            }
        }
    }

    /// True when the saver should stop.
    async fn handle(&mut self, message: ToSaver) -> bool {
        match message {
            ToSaver::Changed(unsaved) => {
                self.pending.merge(unsaved);
                false
            }
            ToSaver::Reopen {
                by,
                intent_id,
                reply,
            } => {
                let answer = self.reopen(&by, intent_id).await;
                let _ = reply.send(answer);
                false
            }
            ToSaver::Finish => {
                self.flush(true).await;
                true
            }
        }
    }

    async fn flush(&mut self, all: bool) {
        let due = self.pending.due(all);
        let index = std::mem::take(&mut self.pending.index);

        let idle = due.is_empty()
            && !index
            && self.pending.closed.is_empty()
            && self.pending.removed.is_empty();
        if idle {
            return;
        }

        let (tabs, index) = self.hub.read_desk(|desk| {
            let tabs: Vec<(TabId, SavedTab)> = due
                .iter()
                .filter_map(|id| desk.saved_tab(*id).map(|saved| (*id, saved)))
                .collect();
            (tabs, index.then(|| desk.saved_index()))
        });

        let pass = Pass {
            tabs,
            index,
            closed: std::mem::take(&mut self.pending.closed),
            removed: std::mem::take(&mut self.pending.removed),
            reopened: std::mem::take(&mut self.pending.reopened),
        };

        let folder = self.folder.clone();
        let hub = self.hub.clone();
        let result = tokio::task::spawn_blocking(move || run_pass(&folder, &hub, pass))
            .await
            .unwrap_or_default();

        self.pending.now.extend(result.failed_tabs.iter().copied());
        self.pending.index |= result.index_failed;
        self.pending.closed.extend(result.closed_left);
        self.pending.removed.extend(result.removed_left);
        self.pending.reopened.extend(result.reopened_left);

        self.report(&result.saved, &result.failures);

        if let Some(ids) = result.closed_now {
            self.tell_closed(&ids);
        }
    }

    /// Sends the count of closed boards whose id is not open; the files were listed with no lock held.
    fn tell_closed(&self, ids: &BTreeSet<TabId>) {
        let waiting = self
            .hub
            .read_desk(|desk| ids.iter().filter(|id| desk.tab(**id).is_none()).count());

        self.hub.set_closed(waiting);
    }

    fn report(&mut self, saved: &[String], failures: &[(String, String)]) {
        self.failing.retain(|file| !saved.contains(file));

        for (file, why) in failures {
            if self.failing.insert(file.clone()) {
                self.hub
                    .add_notice("write_failed", format!("Could not save {file}: {why}."));
            }
        }
    }

    async fn reopen(&mut self, by: &str, intent_id: Option<u64>) -> Result<Applied, Error> {
        self.flush(true).await;

        let open: BTreeSet<TabId> = self
            .hub
            .read_desk(|desk| desk.tabs().iter().map(Tab::id).collect());

        let folder = self.folder.clone();
        let found = tokio::task::spawn_blocking(move || {
            let mut notices = Vec::new();
            let found = newest_closed(&folder, &open, &mut notices);
            (found, notices, closed_ids(&folder))
        })
        .await;

        let (found, notices, ids) = found.unwrap_or((None, Vec::new(), BTreeSet::new()));
        for (code, text) in notices {
            self.hub.add_notice(code, text);
        }

        let Some((tab, path)) = found else {
            self.tell_closed(&ids);
            return Err(Error::NothingClosed(NOTHING_CLOSED.into()));
        };

        let id = tab.id();
        let applied = self.hub.reopen(tab, by, intent_id);
        if applied.is_ok() {
            self.pending.reopened.push((id, path));
        }

        self.tell_closed(&ids);
        applied
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
