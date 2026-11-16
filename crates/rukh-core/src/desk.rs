//! The desk: the open boards, each a whole [`Table`], with one of them shown.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};

use crate::intent::Intent;
use crate::session::{Seat, Session};
use crate::table::{Actor, Applied, Hint, StateBody, Table};
use crate::Error;

pub const MAX_FREE_TABS: usize = 12;

pub const MAX_TAB_NAME_CHARS: usize = 40;

/// Written `t4`. Ids are handed out in order and never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TabId(u32);

impl TabId {
    pub fn number(self) -> u32 {
        self.0
    }
}

impl fmt::Display for TabId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "t{}", self.0)
    }
}

impl FromStr for TabId {
    type Err = ();

    fn from_str(text: &str) -> Result<TabId, ()> {
        let digits = text.strip_prefix('t').ok_or(())?;

        let canonical = !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit())
            && !digits.starts_with('0');
        if !canonical {
            return Err(());
        }

        digits.parse().map(TabId).map_err(|_| ())
    }
}

impl Serialize for TabId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TabKind {
    Free,
    Game,
    Reps,
}

/// The dot on a tab. Computed from its table, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mark {
    YourMove,
    Waiting,
    Paused,
    Over,
}

impl Mark {
    pub fn of(table: &Table) -> Option<Mark> {
        let play = table.match_state();
        if !play.active {
            return None;
        }

        if table.tip_result().is_some() {
            return Some(Mark::Over);
        }

        match play.seats.get(table.session().turn_at_tip()) {
            Seat::Human => Some(Mark::YourMove),
            Seat::Ai | Seat::Engine => Some(Mark::Waiting),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Tab {
    id: TabId,
    name: String,
    kind: TabKind,
    source: Option<String>,
    table: Table,
}

impl Tab {
    pub fn id(&self) -> TabId {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn kind(&self) -> TabKind {
        self.kind
    }

    /// The coach game id (`g0007`) when the tab holds a stored game.
    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    pub fn table(&self) -> &Table {
        &self.table
    }

    pub fn entry(&self) -> TabEntry {
        TabEntry {
            id: self.id,
            name: self.name.clone(),
            kind: self.kind,
            mark: Mark::of(&self.table),
        }
    }
}

/// One item of the frame's `tabs` list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TabEntry {
    pub id: TabId,
    pub name: String,
    pub kind: TabKind,
    pub mark: Option<Mark>,
}

/// A request about the boards themselves, tagged by `op`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TabIntent {
    TabSelect {
        tab: String,
    },
    TabNew {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        copy_of: Option<String>,
    },
    TabRename {
        tab: String,
        name: String,
    },
    TabClose {
        tab: String,
        #[serde(default)]
        abandon: bool,
    },
    TabMove {
        tab: String,
        to: usize,
    },
    TabReopen,
}

impl TabIntent {
    pub fn from_json(text: &str) -> Result<TabIntent, Error> {
        serde_json::from_str(text).map_err(Error::unreadable)
    }
}

/// The two keys a desk reads before the intent itself.
#[derive(Deserialize)]
struct Routing {
    #[serde(default)]
    op: Option<Value>,
    #[serde(default)]
    tab: Option<Value>,
}

impl Routing {
    /// `None` when the text is not a JSON object, so the intent's own parse reports it.
    fn read(text: &str) -> Result<Option<Routing>, Error> {
        match serde_json::from_str::<Routing>(text) {
            Ok(routing) => Ok(Some(routing)),

            Err(e) if serde_json::from_str::<Value>(text).is_ok_and(|v| v.is_object()) => {
                Err(Error::unreadable(e))
            }

            Err(_) => Ok(None),
        }
    }
}

#[derive(Serialize)]
struct FrameOut<'a> {
    t: &'static str,
    instance: &'a str,
    rev: u64,
    now_ms: u64,
    hint: &'a Hint,
    tab: TabId,
    tabs: Vec<TabEntry>,
    state: StateBody,
}

/// Control and invisible characters removed, spaces collapsed, cut to 40 characters.
pub fn clean_tab_name(name: &str) -> Option<String> {
    let visible: String = name
        .chars()
        .filter(|c| c.is_whitespace() || (!c.is_control() && !is_invisible_format(*c)))
        .collect();

    let cleaned: String = visible
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TAB_NAME_CHARS)
        .collect();

    let cleaned = cleaned.trim_end().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'
            | '\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// The open boards, the one shown, and the counters they share.
#[derive(Debug, Clone)]
pub struct Desk {
    tabs: Vec<Tab>,
    selected: TabId,
    rev: u64,
    next_tab: u32,
    next_game_id: u64,
    instance: String,
    hint: Hint,
}

impl Desk {
    /// One free tab, `t1` "Board 1", on the standard position.
    pub fn new(instance: &str) -> Desk {
        let mut desk = Desk {
            tabs: Vec::new(),
            selected: TabId(1),
            rev: 0,
            next_tab: 1,
            next_game_id: 1,
            instance: instance.to_string(),
            hint: Hint {
                reason: "init",
                by: "rukh".to_string(),
                intent_id: None,
            },
        };

        desk.selected = desk.push_tab(TabKind::Free, None, None, Session::default());
        desk
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    pub fn set_instance(&mut self, instance: &str) {
        self.instance = instance.to_string();

        for tab in &mut self.tabs {
            tab.table.set_instance(instance);
        }
    }

    pub fn rev(&self) -> u64 {
        self.rev
    }

    pub fn selected(&self) -> TabId {
        self.selected
    }

    /// The `game_id` the next new game on any tab takes.
    pub fn next_game_id(&self) -> u64 {
        self.next_game_id
    }

    /// In strip order.
    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn tab(&self, id: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == id)
    }

    pub fn table(&self, id: TabId) -> Option<&Table> {
        self.tab(id).map(Tab::table)
    }

    pub fn shown_tab(&self) -> &Tab {
        let i = self.index(self.selected).unwrap_or(0);
        &self.tabs[i]
    }

    pub fn shown(&self) -> &Table {
        &self.shown_tab().table
    }

    pub fn tab_list(&self) -> Vec<TabEntry> {
        self.tabs.iter().map(Tab::entry).collect()
    }

    pub fn free_tabs(&self) -> usize {
        self.tabs.iter().filter(|t| t.kind == TabKind::Free).count()
    }

    /// Reads a tab id as sent and checks that the tab is open.
    pub fn open_id(&self, text: &str) -> Result<TabId, Error> {
        self.open_index(text).map(|(id, _)| id)
    }

    /// The `{"t":"state",...}` frame of the shown tab, with `tab` and `tabs`.
    pub fn frame(&self, now_ms: u64) -> String {
        let out = FrameOut {
            t: "state",
            instance: &self.instance,
            rev: self.rev,
            now_ms,
            hint: &self.hint,
            tab: self.selected,
            tabs: self.tab_list(),
            state: self.shown().state(),
        };

        serde_json::to_string(&out).unwrap_or_else(|e| {
            json!({"t": "error", "message": format!("could not encode the game state: {e}")})
                .to_string()
        })
    }

    pub fn apply(&mut self, by: &str, intent_json: &str, now_ms: u64) -> Result<Applied, Error> {
        self.apply_with_id(by, intent_json, now_ms, None)
    }

    /// A tab intent, or a game intent for its `tab` (the shown tab when it has none).
    pub fn apply_with_id(
        &mut self,
        by: &str,
        intent_json: &str,
        now_ms: u64,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let routing = Routing::read(intent_json)?;

        let op = routing
            .as_ref()
            .and_then(|h| h.op.as_ref())
            .and_then(Value::as_str);
        if op.is_some_and(|op| op.starts_with("tab_")) {
            let intent = TabIntent::from_json(intent_json)?;
            return self.apply_tab(by, intent, now_ms, intent_id);
        }

        let tab = match routing.and_then(|r| r.tab) {
            None => self.selected,
            Some(Value::String(text)) => self.open_id(&text)?,
            Some(_) => {
                return Err(Error::BadInput(
                    "tab must be a board id such as \"t1\"".into(),
                ))
            }
        };

        self.apply_on(tab, by, intent_json, now_ms, intent_id)
    }

    /// A game intent for one tab, shown or not.
    pub fn apply_on(
        &mut self,
        tab: TabId,
        by: &str,
        intent_json: &str,
        now_ms: u64,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        self.require_index(tab)?;

        let intent = Intent::from_json(intent_json)?;
        self.apply_intent_on(tab, by, intent, now_ms, intent_id)
    }

    pub fn apply_intent_on(
        &mut self,
        tab: TabId,
        by: &str,
        intent: Intent,
        now_ms: u64,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        let i = self.require_index(tab)?;

        let table = &mut self.tabs[i].table;
        table.set_next_game_id(self.next_game_id);

        let applied = table.apply_intent(by, intent, now_ms, intent_id);
        self.next_game_id = table.next_game_id();

        let mut applied = applied?;
        if applied.changed {
            self.rev = applied.rev;
            self.hint = self.tabs[i].table.hint().clone();
            self.sync_revs();
        }

        applied.frame_json = self.frame(now_ms);
        Ok(applied)
    }

    /// A tab made by the program; it is not selected.
    pub fn open_tab(
        &mut self,
        kind: TabKind,
        name: &str,
        source: Option<String>,
        by: &str,
    ) -> Result<TabId, Error> {
        if kind == TabKind::Free {
            self.check_limit()?;
        }

        let name = clean_tab_name(name).ok_or_else(|| {
            Error::BadInput("A board the program opens needs a visible name.".into())
        })?;

        let id = self.push_tab(kind, Some(name), source, Session::default());
        self.record_change("tab_new", by, None);

        Ok(id)
    }

    fn apply_tab(
        &mut self,
        by: &str,
        intent: TabIntent,
        now_ms: u64,
        intent_id: Option<u64>,
    ) -> Result<Applied, Error> {
        if Actor::of(by) == Actor::Ai {
            return Err(Error::BadInput(
                "Boards are opened, chosen and closed by the person; an AI cannot do it.".into(),
            ));
        }

        let (result, reason) = match intent {
            TabIntent::TabSelect { tab } => self.select(&tab)?,
            TabIntent::TabNew { name, copy_of } => self.new_tab(name.as_deref(), copy_of)?,
            TabIntent::TabRename { tab, name } => self.rename(&tab, &name)?,
            TabIntent::TabClose { tab, .. } => self.close(&tab)?,
            TabIntent::TabMove { tab, to } => self.move_tab(&tab, to)?,
            TabIntent::TabReopen => {
                return Err(Error::NothingClosed(
                    "There is no closed board to reopen.".into(),
                ))
            }
        };

        let changed = reason.is_some();
        if let Some(reason) = reason {
            self.record_change(reason, by, intent_id);
        }

        Ok(Applied {
            frame_json: self.frame(now_ms),
            result_json: result.to_string(),
            result,
            rev: self.rev,
            changed,
        })
    }

    fn select(&mut self, text: &str) -> Result<(Value, Option<&'static str>), Error> {
        let id = self.open_id(text)?;
        let changed = id != self.selected;

        self.selected = id;
        Ok((json!({"selected": id}), changed.then_some("tab_select")))
    }

    fn new_tab(
        &mut self,
        name: Option<&str>,
        copy_of: Option<String>,
    ) -> Result<(Value, Option<&'static str>), Error> {
        self.check_limit()?;

        let session = match copy_of {
            None => Session::default(),
            Some(text) => {
                let (_, i) = self.open_index(&text)?;
                let source = &self.tabs[i].table;

                let mut session = Session::default();
                session.game = source.game().clone();
                session.study = source.session().study.clone();
                session
            }
        };

        let id = self.push_tab(TabKind::Free, name.and_then(clean_tab_name), None, session);
        self.selected = id;

        Ok((json!({"tab": id}), Some("tab_new")))
    }

    fn rename(&mut self, text: &str, name: &str) -> Result<(Value, Option<&'static str>), Error> {
        let (_, i) = self.open_index(text)?;

        let name = clean_tab_name(name).ok_or_else(|| {
            Error::BadInput("A board needs a name with at least one visible character.".into())
        })?;

        let tab = &mut self.tabs[i];
        let changed = tab.name != name;
        tab.name.clone_from(&name);

        Ok((
            json!({"tab": tab.id, "name": name}),
            changed.then_some("tab_rename"),
        ))
    }

    fn close(&mut self, text: &str) -> Result<(Value, Option<&'static str>), Error> {
        let (id, i) = self.open_index(text)?;

        self.tabs.remove(i);

        if self.tabs.is_empty() {
            self.selected = self.push_tab(TabKind::Free, None, None, Session::default());
        } else if self.selected == id {
            self.selected = self.tabs[i.min(self.tabs.len() - 1)].id;
        }

        Ok((
            json!({"closed": id, "selected": self.selected}),
            Some("tab_close"),
        ))
    }

    fn move_tab(&mut self, text: &str, to: usize) -> Result<(Value, Option<&'static str>), Error> {
        let (id, i) = self.open_index(text)?;

        if to >= self.tabs.len() {
            return Err(Error::BadInput(format!(
                "to must be a place from 0 to {}",
                self.tabs.len() - 1
            )));
        }

        let changed = i != to;
        if changed {
            let tab = self.tabs.remove(i);
            self.tabs.insert(to, tab);
        }

        let order: Vec<TabId> = self.tabs.iter().map(|t| t.id).collect();
        Ok((
            json!({"tab": id, "order": order}),
            changed.then_some("tab_move"),
        ))
    }

    fn check_limit(&self) -> Result<(), Error> {
        if self.free_tabs() >= MAX_FREE_TABS {
            return Err(Error::TabLimit("Close a board first.".into()));
        }

        Ok(())
    }

    fn push_tab(
        &mut self,
        kind: TabKind,
        name: Option<String>,
        source: Option<String>,
        session: Session,
    ) -> TabId {
        let id = TabId(self.next_tab);
        self.next_tab += 1;

        let name = name.unwrap_or_else(|| self.default_name());

        let mut table = Table::with_session(&self.instance, session);
        table.set_rev(self.rev);
        table.set_game_id(self.next_game_id);
        self.next_game_id += 1;

        self.tabs.push(Tab {
            id,
            name,
            kind,
            source,
            table,
        });

        id
    }

    /// The lowest "Board n" no open tab is called.
    fn default_name(&self) -> String {
        (1..)
            .map(|n| format!("Board {n}"))
            .find(|name| self.tabs.iter().all(|t| &t.name != name))
            .unwrap_or_else(|| "Board".to_string())
    }

    fn record_change(&mut self, reason: &'static str, by: &str, intent_id: Option<u64>) {
        self.rev += 1;
        self.hint = Hint {
            reason,
            by: by.to_string(),
            intent_id,
        };

        self.sync_revs();
    }

    /// Every table carries the desk's rev, so its own frame never shows an older one.
    fn sync_revs(&mut self) {
        for tab in &mut self.tabs {
            tab.table.set_rev(self.rev);
        }
    }

    fn index(&self, id: TabId) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    fn require_index(&self, id: TabId) -> Result<usize, Error> {
        self.index(id).ok_or_else(|| unknown_tab(&id.to_string()))
    }

    fn open_index(&self, text: &str) -> Result<(TabId, usize), Error> {
        text.parse::<TabId>()
            .ok()
            .and_then(|id| self.index(id).map(|i| (id, i)))
            .ok_or_else(|| unknown_tab(text))
    }
}

fn unknown_tab(text: &str) -> Error {
    let quoted: String = text.chars().take(20).collect();
    Error::UnknownTab(format!(
        "There is no open board {quoted:?}; it may have been closed."
    ))
}
