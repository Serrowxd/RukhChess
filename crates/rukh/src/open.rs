//! Opening the board once the server is up.
//!
//! By default the board opens in its own window: an installed Chromium-based browser started in
//! app mode (no tabs, no address bar) with its own profile folder and the switch that puts it on
//! the high-performance graphics card. On a machine with two graphics adapters, Chromium runs every
//! page on the integrated one and ignores the page's own WebGL request for the faster adapter, so
//! the switch has to be given to a browser process this program starts itself; a browser that is
//! already running cannot take it. A separate profile folder makes that a new process even while
//! the same browser is open with the person's own profile.
//!
//! Every decision here goes through [`System`], so tests use a fake that records what would be
//! started and never touches the real environment, file system or processes.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

/// The folder inside the data directory that holds the window's browser profile.
pub const PROFILE_DIR: &str = "window-profile";

/// Environment variable naming a browser executable to use for the window before any other.
pub const BROWSER_ENV: &str = "RUKH_BROWSER";

/// How the board is opened at start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    /// A Rukh window: a Chromium-based browser in app mode on the high-performance graphics card.
    Window,
    /// The default browser, in whatever window and on whatever graphics card it already uses.
    Browser,
    /// Not opened; only the link is printed.
    None,
}

impl OpenMode {
    /// Reads the value of `--open`. The error text says which values are allowed.
    pub fn parse(value: &str) -> Result<OpenMode, String> {
        match value {
            "window" => Ok(OpenMode::Window),
            "browser" => Ok(OpenMode::Browser),
            "none" => Ok(OpenMode::None),
            _ => Err(format!(
                "--open must be window, browser or none (got {value})"
            )),
        }
    }
}

/// The operating system family, which decides where browsers and the data directory live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    /// The system this program was built for. Anything that is not Windows or macOS is treated
    /// like Linux (PATH lookup, XDG folders).
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// What opening the board needs from the machine.
pub trait System {
    /// The value of an environment variable, if it is set.
    fn env(&self, name: &str) -> Option<OsString>;
    /// Whether a file that can be run exists at this path (on Unix: with an execute bit set).
    fn is_program(&self, path: &Path) -> bool;
    /// The path made absolute against the current folder, so a browser started from elsewhere
    /// finds the same folder.
    fn absolute(&self, path: &Path) -> io::Result<PathBuf>;
    /// Creates a folder and any missing parents.
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    /// Starts a program detached from this one, with its output discarded, without waiting for it.
    fn spawn_detached(&self, program: &Path, args: &[OsString]) -> io::Result<()>;
    /// Opens a link in the default browser.
    fn open_default(&self, link: &str) -> io::Result<()>;
}

/// A browser that can show the board in its own window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Browser {
    pub name: String,
    pub path: PathBuf,
}

/// The browsers looked for, in order, with the path of each one's executable relative to a base
/// folder (a Windows install folder, or a macOS Applications folder).
const WINDOWS_BROWSERS: &[(&str, &[&str], &str)] = &[
    (
        "Microsoft Edge",
        &["ProgramFiles(x86)", "ProgramFiles"],
        "Microsoft/Edge/Application/msedge.exe",
    ),
    (
        "Google Chrome",
        &["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"],
        "Google/Chrome/Application/chrome.exe",
    ),
    (
        "Brave",
        &["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"],
        "BraveSoftware/Brave-Browser/Application/brave.exe",
    ),
    (
        "Vivaldi",
        &["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"],
        "Vivaldi/Application/vivaldi.exe",
    ),
];

const MAC_BROWSERS: &[(&str, &str)] = &[
    (
        "Google Chrome",
        "Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    (
        "Microsoft Edge",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ),
    ("Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"),
    ("Chromium", "Chromium.app/Contents/MacOS/Chromium"),
];

const LINUX_BROWSERS: &[(&str, &str)] = &[
    ("Google Chrome", "google-chrome"),
    ("Google Chrome", "google-chrome-stable"),
    ("Chromium", "chromium"),
    ("Chromium", "chromium-browser"),
    ("Microsoft Edge", "microsoft-edge"),
    ("Brave", "brave-browser"),
];

/// The browsers searched for on this system, for the message when none is found.
fn searched_names(os: Os) -> String {
    let mut names: Vec<&str> = match os {
        Os::Windows => WINDOWS_BROWSERS.iter().map(|b| b.0).collect(),
        Os::Mac => MAC_BROWSERS.iter().map(|b| b.0).collect(),
        Os::Linux => LINUX_BROWSERS.iter().map(|b| b.0).collect(),
    };
    names.dedup();
    names.join(", ")
}

/// A non-empty environment variable as a path.
fn env_path(sys: &dyn System, name: &str) -> Option<PathBuf> {
    sys.env(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Joins a relative path written with forward slashes onto a base, one part at a time.
fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// Splits a PATH value with the separator of the given system (not the one this program was
/// built for, so the tests can check every system from any machine). On Unix the value is split
/// as raw bytes, so a folder whose name is not UTF-8 stays the same folder.
fn split_path_var(os: Os, value: &OsStr) -> Vec<PathBuf> {
    let separator = if os == Os::Windows { b';' } else { b':' };
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        value
            .as_bytes()
            .split(|byte| *byte == separator)
            .filter(|part| !part.is_empty())
            .map(|part| PathBuf::from(OsStr::from_bytes(part)))
            .collect()
    }
    #[cfg(not(unix))]
    {
        value
            .to_string_lossy()
            .split(char::from(separator))
            .filter(|part| !part.is_empty())
            .map(PathBuf::from)
            .collect()
    }
}

/// The line to print when `RUKH_BROWSER` is set but does not name a program, so it is not used.
pub fn ignored_browser_env(sys: &dyn System) -> Option<String> {
    let path = env_path(sys, BROWSER_ENV)?;
    if sys.is_program(&path) {
        return None;
    }
    Some(format!(
        "{BROWSER_ENV} is set to {}, which is not a program file, so it is not used.",
        path.display()
    ))
}

/// Finds a Chromium-based browser: `RUKH_BROWSER` first when it names a program file, then the
/// usual install places for this system, taking the first that exists.
pub fn find_browser(sys: &dyn System, os: Os) -> Option<Browser> {
    if let Some(path) = env_path(sys, BROWSER_ENV).filter(|p| sys.is_program(p)) {
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| BROWSER_ENV.to_string());
        return Some(Browser { name, path });
    }
    match os {
        Os::Windows => WINDOWS_BROWSERS.iter().find_map(|(name, bases, rel)| {
            bases
                .iter()
                .filter_map(|var| env_path(sys, var))
                .map(|base| join_rel(&base, rel))
                .find(|path| sys.is_program(path))
                .map(|path| Browser {
                    name: (*name).to_string(),
                    path,
                })
        }),
        Os::Mac => {
            let mut folders = vec![PathBuf::from("/Applications")];
            if let Some(home) = env_path(sys, "HOME") {
                folders.push(home.join("Applications"));
            }
            MAC_BROWSERS.iter().find_map(|(name, rel)| {
                folders
                    .iter()
                    .map(|folder| join_rel(folder, rel))
                    .find(|path| sys.is_program(path))
                    .map(|path| Browser {
                        name: (*name).to_string(),
                        path,
                    })
            })
        }
        Os::Linux => {
            let dirs = sys
                .env("PATH")
                .map(|value| split_path_var(os, &value))
                .unwrap_or_default();
            LINUX_BROWSERS.iter().find_map(|(name, command)| {
                dirs.iter()
                    .map(|dir| dir.join(command))
                    .find(|path| sys.is_program(path))
                    .map(|path| Browser {
                        name: (*name).to_string(),
                        path,
                    })
            })
        }
    }
}

/// Where the program keeps its files when `--data-dir` is not given, or None when the environment
/// does not say (the variable it is built from is not set).
pub fn default_data_dir(sys: &dyn System, os: Os) -> Option<PathBuf> {
    match os {
        Os::Windows => env_path(sys, "LOCALAPPDATA").map(|dir| dir.join("Rukh")),
        Os::Mac => env_path(sys, "HOME").map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("Rukh")
        }),
        Os::Linux => env_path(sys, "XDG_DATA_HOME")
            .filter(|dir| dir.is_absolute() || dir.starts_with("/"))
            .map(|dir| dir.join("rukh"))
            .or_else(|| {
                env_path(sys, "HOME").map(|home| home.join(".local").join("share").join("rukh"))
            }),
    }
}

/// The variable the default data directory is built from, for the message when it is missing.
fn data_dir_source(os: Os) -> &'static str {
    match os {
        Os::Windows => "LOCALAPPDATA",
        Os::Mac | Os::Linux => "HOME",
    }
}

/// The arguments the browser is started with for a Rukh window.
pub fn window_args(link: &str, profile: &Path) -> Vec<OsString> {
    let mut user_data_dir = OsString::from("--user-data-dir=");
    user_data_dir.push(profile.as_os_str());
    vec![
        OsString::from(format!("--app={link}")),
        user_data_dir,
        OsString::from("--force-high-performance-gpu"),
        // Keep the window plain: none of the person's browser extensions, no account sign-in
        // and no syncing of their browser data into Rukh's own profile.
        OsString::from("--disable-extensions"),
        OsString::from("--disable-sync"),
        OsString::from("--disable-features=msImplicitSignin"),
        OsString::from("--no-first-run"),
        OsString::from("--no-default-browser-check"),
        OsString::from("--window-size=1280,900"),
    ]
}

/// How the board ended up being opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// In a Rukh window started from this browser.
    Window(String),
    /// In the default browser.
    DefaultBrowser,
    /// Not opened.
    Nowhere,
}

/// What happened, with the lines to print (a reason for any fallback, then how it was opened).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub opened: Opened,
    pub lines: Vec<String>,
}

const NOT_OPENED: &str = "Not opened; open the link yourself.";
const IN_DEFAULT: &str = "Opened in your default browser.";

/// Opens the default browser, or says it could not.
fn open_in_default(sys: &dyn System, link: &str, mut lines: Vec<String>) -> Outcome {
    match sys.open_default(link) {
        Ok(()) => {
            lines.push(IN_DEFAULT.to_string());
            Outcome {
                opened: Opened::DefaultBrowser,
                lines,
            }
        }
        Err(e) => {
            lines.push(format!("Could not open your default browser ({e})."));
            lines.push(NOT_OPENED.to_string());
            Outcome {
                opened: Opened::Nowhere,
                lines,
            }
        }
    }
}

/// Starts a Rukh window, or returns why it could not.
fn open_window(
    sys: &dyn System,
    os: Os,
    link: &str,
    data_dir: Option<&Path>,
) -> Result<String, String> {
    let browser = find_browser(sys, os).ok_or_else(|| {
        format!(
            "No Chromium-based browser was found (looked for {}; set {BROWSER_ENV} to the program \
             file of another Chromium-based browser to use it)",
            searched_names(os)
        )
    })?;
    let data_dir = match data_dir {
        Some(dir) => dir.to_path_buf(),
        None => default_data_dir(sys, os).ok_or_else(|| {
            format!(
                "Could not tell where to keep the window's profile ({} is not set; pass --data-dir)",
                data_dir_source(os)
            )
        })?,
    };
    // The browser resolves a relative profile path against its own working folder, so it gets an
    // absolute one.
    let data_dir = sys.absolute(&data_dir).map_err(|e| {
        format!(
            "Could not tell where the data folder {} is ({e})",
            data_dir.display()
        )
    })?;
    let profile = data_dir.join(PROFILE_DIR);
    sys.create_dir_all(&profile).map_err(|e| {
        format!(
            "Could not create the window's profile folder {} ({e})",
            profile.display()
        )
    })?;
    sys.spawn_detached(&browser.path, &window_args(link, &profile))
        .map_err(|e| {
            format!(
                "Could not start {} at {} ({e})",
                browser.name,
                browser.path.display()
            )
        })?;
    Ok(browser.name)
}

/// Opens the board as asked. With `Window`, falls back to the default browser (saying why) when no
/// suitable browser is found or it cannot be started.
pub fn open_board(
    sys: &dyn System,
    os: Os,
    mode: OpenMode,
    link: &str,
    data_dir: Option<&Path>,
) -> Outcome {
    match mode {
        OpenMode::None => Outcome {
            opened: Opened::Nowhere,
            lines: vec![NOT_OPENED.to_string()],
        },
        OpenMode::Browser => open_in_default(sys, link, Vec::new()),
        OpenMode::Window => {
            let mut lines: Vec<String> = ignored_browser_env(sys).into_iter().collect();
            match open_window(sys, os, link, data_dir) {
                Ok(name) => {
                    lines.push(format!(
                        "Opened in a Rukh window ({name}), on the high-performance graphics card \
                         where the system has one."
                    ));
                    Outcome {
                        lines,
                        opened: Opened::Window(name),
                    }
                }
                Err(reason) => {
                    lines.push(format!("{reason}, so the default browser is used instead."));
                    open_in_default(sys, link, lines)
                }
            }
        }
    }
}

/// Stops this program's own standard handles from being inherited by a program it starts.
/// Windows hands every inheritable handle to a child, not only the ones given as its stdio; when
/// this program's output is a pipe, the browser would hold that pipe open until its window closes,
/// and whatever reads the pipe would wait for it after this program has exited.
#[cfg(windows)]
fn stop_std_handle_inheritance() {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(which: u32) -> *mut c_void;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
    }
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE (-10, -11, -12 as DWORD).
    const STD_HANDLES: [u32; 3] = [0xFFFF_FFF6, 0xFFFF_FFF5, 0xFFFF_FFF4];
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    for which in STD_HANDLES {
        // SAFETY: GetStdHandle takes any value and returns a handle, null or INVALID_HANDLE_VALUE;
        // only a real handle is passed on, and SetHandleInformation only changes its inherit flag
        // (a failure there leaves the handle as it was, which is harmless).
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle as isize != -1 {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// The real machine.
pub struct RealSystem;

impl System for RealSystem {
    fn env(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }

    fn is_program(&self, path: &Path) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)
                .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            path.is_file()
        }
    }

    fn absolute(&self, path: &Path) -> io::Result<PathBuf> {
        std::path::absolute(path)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        std::fs::create_dir_all(path)
    }

    fn spawn_detached(&self, program: &Path, args: &[OsString]) -> io::Result<()> {
        use std::process::{Command, Stdio};
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console of its own and not in this console's group, so Ctrl+C here leaves it be.
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            stop_std_handle_inheritance();
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so Ctrl+C in this terminal does not reach it.
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        // Collect its exit status in the background so it does not linger as a zombie; nothing
        // waits on this thread.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    fn open_default(&self, link: &str) -> io::Result<()> {
        webbrowser::open(link)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    /// A machine made of a map of environment variables and a set of files. It records what would
    /// be created or started instead of doing it.
    #[derive(Default)]
    struct Fake {
        env: HashMap<String, String>,
        files: HashSet<String>,
        /// Files that exist but cannot be run (no execute bit).
        not_runnable: HashSet<String>,
        /// The current folder relative paths are made absolute against.
        cwd: Option<String>,
        mkdir_fails: bool,
        spawn_fails: bool,
        default_fails: bool,
        created: RefCell<Vec<PathBuf>>,
        spawned: RefCell<Vec<(PathBuf, Vec<OsString>)>>,
        opened_default: RefCell<Vec<String>>,
    }

    /// Paths compared with forward slashes, so a fake Linux or macOS file system works the same
    /// when the tests run on Windows.
    fn norm(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    impl Fake {
        fn with_env(mut self, name: &str, value: &str) -> Self {
            self.env.insert(name.to_string(), value.to_string());
            self
        }
        fn with_file(mut self, path: &str) -> Self {
            self.files.insert(path.to_string());
            self
        }
        fn with_plain_file(mut self, path: &str) -> Self {
            self.not_runnable.insert(path.to_string());
            self.with_file(path)
        }
    }

    impl System for Fake {
        fn env(&self, name: &str) -> Option<OsString> {
            self.env.get(name).map(OsString::from)
        }
        fn is_program(&self, path: &Path) -> bool {
            let path = norm(path);
            self.files.contains(&path) && !self.not_runnable.contains(&path)
        }
        fn absolute(&self, path: &Path) -> io::Result<PathBuf> {
            // "/x" and "C:/x" both count as absolute here, so fake paths of every system work
            // wherever the tests run.
            let n = norm(path);
            if path.is_absolute() || n.starts_with('/') || n.get(1..3) == Some(":/") {
                return Ok(path.to_path_buf());
            }
            match &self.cwd {
                Some(cwd) => Ok(Path::new(cwd).join(path)),
                None => Err(io::Error::other("no current folder")),
            }
        }
        fn create_dir_all(&self, path: &Path) -> io::Result<()> {
            if self.mkdir_fails {
                return Err(io::Error::other("disk full"));
            }
            self.created.borrow_mut().push(path.to_path_buf());
            Ok(())
        }
        fn spawn_detached(&self, program: &Path, args: &[OsString]) -> io::Result<()> {
            if self.spawn_fails {
                return Err(io::Error::other("access denied"));
            }
            self.spawned
                .borrow_mut()
                .push((program.to_path_buf(), args.to_vec()));
            Ok(())
        }
        fn open_default(&self, link: &str) -> io::Result<()> {
            if self.default_fails {
                return Err(io::Error::other("no handler"));
            }
            self.opened_default.borrow_mut().push(link.to_string());
            Ok(())
        }
    }

    fn windows() -> Fake {
        Fake::default()
            .with_env("ProgramFiles", "C:/PF")
            .with_env("ProgramFiles(x86)", "C:/PF86")
            .with_env("LOCALAPPDATA", "C:/Home/Local")
    }

    fn found(sys: &Fake, os: Os) -> Option<(String, String)> {
        find_browser(sys, os).map(|b| (b.name, norm(&b.path)))
    }

    #[test]
    fn windows_discovery_order() {
        let sys = windows();
        assert_eq!(found(&sys, Os::Windows), None);

        let sys = windows().with_file("C:/Home/Local/Vivaldi/Application/vivaldi.exe");
        assert_eq!(
            found(&sys, Os::Windows),
            Some((
                "Vivaldi".into(),
                "C:/Home/Local/Vivaldi/Application/vivaldi.exe".into()
            ))
        );

        let sys = windows()
            .with_file("C:/Home/Local/Vivaldi/Application/vivaldi.exe")
            .with_file("C:/PF/BraveSoftware/Brave-Browser/Application/brave.exe");
        assert_eq!(found(&sys, Os::Windows).map(|b| b.0), Some("Brave".into()));

        // Chrome installed for one user only, under LOCALAPPDATA.
        let sys = windows()
            .with_file("C:/PF/BraveSoftware/Brave-Browser/Application/brave.exe")
            .with_file("C:/Home/Local/Google/Chrome/Application/chrome.exe");
        assert_eq!(
            found(&sys, Os::Windows),
            Some((
                "Google Chrome".into(),
                "C:/Home/Local/Google/Chrome/Application/chrome.exe".into()
            ))
        );

        // Edge wins, and the (x86) folder is tried before the 64-bit one.
        let sys = windows()
            .with_file("C:/Home/Local/Google/Chrome/Application/chrome.exe")
            .with_file("C:/PF/Microsoft/Edge/Application/msedge.exe")
            .with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        assert_eq!(
            found(&sys, Os::Windows),
            Some((
                "Microsoft Edge".into(),
                "C:/PF86/Microsoft/Edge/Application/msedge.exe".into()
            ))
        );
        let sys = windows().with_file("C:/PF/Microsoft/Edge/Application/msedge.exe");
        assert_eq!(
            found(&sys, Os::Windows).map(|b| b.1),
            Some("C:/PF/Microsoft/Edge/Application/msedge.exe".into())
        );

        // With no environment at all nothing is guessed.
        let sys =
            Fake::default().with_file("C:/Program Files/Microsoft/Edge/Application/msedge.exe");
        assert_eq!(found(&sys, Os::Windows), None);
    }

    #[test]
    fn macos_discovery_order() {
        let sys = Fake::default().with_env("HOME", "/Users/someone");
        assert_eq!(found(&sys, Os::Mac), None);

        let sys = Fake::default()
            .with_env("HOME", "/Users/someone")
            .with_file("/Users/someone/Applications/Chromium.app/Contents/MacOS/Chromium")
            .with_file("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
        assert_eq!(
            found(&sys, Os::Mac),
            Some((
                "Brave".into(),
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser".into()
            ))
        );

        let sys = Fake::default()
            .with_env("HOME", "/Users/someone")
            .with_file("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
            .with_file(
                "/Users/someone/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            );
        assert_eq!(
            found(&sys, Os::Mac),
            Some((
                "Google Chrome".into(),
                "/Users/someone/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into()
            ))
        );
    }

    #[test]
    fn linux_discovery_order() {
        let sys = Fake::default().with_env("PATH", "/usr/local/bin:/usr/bin");
        assert_eq!(found(&sys, Os::Linux), None);

        let sys = Fake::default()
            .with_env("PATH", "/usr/local/bin:/usr/bin")
            .with_file("/usr/bin/brave-browser")
            .with_file("/usr/bin/chromium-browser");
        assert_eq!(
            found(&sys, Os::Linux),
            Some(("Chromium".into(), "/usr/bin/chromium-browser".into()))
        );

        let sys = Fake::default()
            .with_env("PATH", "/usr/local/bin:/usr/bin")
            .with_file("/usr/bin/chromium")
            .with_file("/usr/bin/google-chrome-stable");
        assert_eq!(
            found(&sys, Os::Linux),
            Some((
                "Google Chrome".into(),
                "/usr/bin/google-chrome-stable".into()
            ))
        );

        // Earlier PATH entries are searched first for the same command.
        let sys = Fake::default()
            .with_env("PATH", "/opt/bin:/usr/bin")
            .with_file("/usr/bin/microsoft-edge")
            .with_file("/opt/bin/microsoft-edge");
        assert_eq!(
            found(&sys, Os::Linux).map(|b| b.1),
            Some("/opt/bin/microsoft-edge".into())
        );

        // A file on disk that is not on PATH is not found.
        let sys = Fake::default().with_file("/usr/bin/chromium");
        assert_eq!(found(&sys, Os::Linux), None);
    }

    #[test]
    fn rukh_browser_wins_when_it_exists() {
        let sys = windows()
            .with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe")
            .with_file("D:/Tools/thorium.exe")
            .with_env(BROWSER_ENV, "D:/Tools/thorium.exe");
        assert_eq!(
            found(&sys, Os::Windows),
            Some(("thorium".into(), "D:/Tools/thorium.exe".into()))
        );

        // Set to something that does not exist: the usual search goes on.
        let sys = windows()
            .with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe")
            .with_env(BROWSER_ENV, "D:/Tools/missing.exe");
        assert_eq!(
            found(&sys, Os::Windows).map(|b| b.0),
            Some("Microsoft Edge".into())
        );

        let sys = Fake::default()
            .with_file("/opt/thorium/thorium")
            .with_env(BROWSER_ENV, "/opt/thorium/thorium");
        assert_eq!(
            found(&sys, Os::Linux).map(|b| b.1),
            Some("/opt/thorium/thorium".into())
        );
    }

    #[test]
    fn window_argument_list() {
        let profile = Path::new("C:/Data/Rukh").join(PROFILE_DIR);
        let args: Vec<String> = window_args("http://127.0.0.1:47474/", &profile)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--app=http://127.0.0.1:47474/".to_string(),
                format!("--user-data-dir={}", profile.display()),
                "--force-high-performance-gpu".to_string(),
                "--disable-extensions".to_string(),
                "--disable-sync".to_string(),
                "--disable-features=msImplicitSignin".to_string(),
                "--no-first-run".to_string(),
                "--no-default-browser-check".to_string(),
                "--window-size=1280,900".to_string(),
            ]
        );
    }

    #[test]
    fn window_opens_with_its_own_profile() {
        let sys = windows().with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        let link = "http://127.0.0.1:47481/";
        let data = Path::new("C:/Scratch/data");
        let out = open_board(&sys, Os::Windows, OpenMode::Window, link, Some(data));
        assert_eq!(out.opened, Opened::Window("Microsoft Edge".into()));
        assert_eq!(
            out.lines,
            vec![
                "Opened in a Rukh window (Microsoft Edge), on the high-performance graphics card \
                 where the system has one."
                    .to_string()
            ]
        );
        let profile = data.join(PROFILE_DIR);
        assert_eq!(*sys.created.borrow(), vec![profile.clone()]);
        let spawned = sys.spawned.borrow();
        assert_eq!(spawned.len(), 1);
        assert_eq!(
            norm(&spawned[0].0),
            "C:/PF86/Microsoft/Edge/Application/msedge.exe"
        );
        assert_eq!(spawned[0].1, window_args(link, &profile));
        assert!(sys.opened_default.borrow().is_empty());
    }

    #[test]
    fn window_uses_the_default_data_dir_without_data_dir() {
        let sys = windows().with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        let out = open_board(&sys, Os::Windows, OpenMode::Window, "http://x/", None);
        assert_eq!(out.opened, Opened::Window("Microsoft Edge".into()));
        assert_eq!(
            *sys.created.borrow(),
            vec![Path::new("C:/Home/Local").join("Rukh").join(PROFILE_DIR)]
        );
    }

    #[test]
    fn falls_back_when_no_browser_is_found() {
        let sys = windows();
        let out = open_board(
            &sys,
            Os::Windows,
            OpenMode::Window,
            "http://x/",
            Some(Path::new("C:/Scratch/data")),
        );
        assert_eq!(out.opened, Opened::DefaultBrowser);
        assert_eq!(out.lines.len(), 2);
        assert!(out.lines[0].starts_with("No Chromium-based browser was found (looked for Microsoft Edge, Google Chrome, Brave, Vivaldi;"));
        assert!(out.lines[0].ends_with("so the default browser is used instead."));
        assert_eq!(out.lines[1], "Opened in your default browser.");
        assert_eq!(*sys.opened_default.borrow(), vec!["http://x/".to_string()]);
        assert!(
            sys.created.borrow().is_empty(),
            "no profile folder without a window"
        );
        assert!(sys.spawned.borrow().is_empty());
    }

    #[test]
    fn falls_back_when_the_launch_fails() {
        let mut sys = windows().with_file("C:/PF/Microsoft/Edge/Application/msedge.exe");
        sys.spawn_fails = true;
        let out = open_board(
            &sys,
            Os::Windows,
            OpenMode::Window,
            "http://x/",
            Some(Path::new("C:/Scratch/data")),
        );
        assert_eq!(out.opened, Opened::DefaultBrowser);
        assert!(out.lines[0].starts_with("Could not start Microsoft Edge at "));
        assert!(out.lines[0].contains("access denied"));
        assert_eq!(out.lines[1], "Opened in your default browser.");
        assert_eq!(*sys.opened_default.borrow(), vec!["http://x/".to_string()]);
    }

    #[test]
    fn falls_back_when_no_data_dir_can_be_found() {
        let sys = Fake::default()
            .with_env("ProgramFiles", "C:/PF")
            .with_file("C:/PF/Microsoft/Edge/Application/msedge.exe");
        let out = open_board(&sys, Os::Windows, OpenMode::Window, "http://x/", None);
        assert_eq!(out.opened, Opened::DefaultBrowser);
        assert!(out.lines[0].contains("LOCALAPPDATA is not set"));
        assert!(sys.created.borrow().is_empty());
        assert!(sys.spawned.borrow().is_empty());
    }

    #[test]
    fn default_browser_and_none() {
        let sys = windows().with_file("C:/PF/Microsoft/Edge/Application/msedge.exe");
        let out = open_board(&sys, Os::Windows, OpenMode::Browser, "http://x/", None);
        assert_eq!(out.opened, Opened::DefaultBrowser);
        assert_eq!(
            out.lines,
            vec!["Opened in your default browser.".to_string()]
        );
        assert!(sys.spawned.borrow().is_empty());

        let sys = windows().with_file("C:/PF/Microsoft/Edge/Application/msedge.exe");
        let out = open_board(&sys, Os::Windows, OpenMode::None, "http://x/", None);
        assert_eq!(out.opened, Opened::Nowhere);
        assert_eq!(
            out.lines,
            vec!["Not opened; open the link yourself.".to_string()]
        );
        assert!(
            sys.created.borrow().is_empty(),
            "no folder unless a window opens"
        );
        assert!(sys.spawned.borrow().is_empty());
        assert!(sys.opened_default.borrow().is_empty());

        let mut sys = windows();
        sys.default_fails = true;
        let out = open_board(&sys, Os::Windows, OpenMode::Window, "http://x/", None);
        assert_eq!(out.opened, Opened::Nowhere);
        assert_eq!(out.lines.last().map(String::as_str), Some(NOT_OPENED));
        assert!(out.lines.iter().any(|l| l.contains("no handler")));
    }

    #[test]
    fn default_data_dir_per_os() {
        let sys = windows();
        assert_eq!(
            default_data_dir(&sys, Os::Windows),
            Some(Path::new("C:/Home/Local").join("Rukh"))
        );
        assert_eq!(default_data_dir(&Fake::default(), Os::Windows), None);

        let sys = Fake::default().with_env("HOME", "/Users/someone");
        assert_eq!(
            default_data_dir(&sys, Os::Mac),
            Some(
                Path::new("/Users/someone")
                    .join("Library")
                    .join("Application Support")
                    .join("Rukh")
            )
        );

        let sys = Fake::default().with_env("HOME", "/home/someone");
        assert_eq!(
            default_data_dir(&sys, Os::Linux),
            Some(
                Path::new("/home/someone")
                    .join(".local")
                    .join("share")
                    .join("rukh")
            )
        );
        let sys = Fake::default()
            .with_env("HOME", "/home/someone")
            .with_env("XDG_DATA_HOME", "/data/xdg");
        assert_eq!(
            default_data_dir(&sys, Os::Linux),
            Some(Path::new("/data/xdg").join("rukh"))
        );
        // A relative XDG_DATA_HOME is ignored, as the XDG rules say.
        let sys = Fake::default()
            .with_env("HOME", "/home/someone")
            .with_env("XDG_DATA_HOME", "relative/dir");
        assert_eq!(
            default_data_dir(&sys, Os::Linux),
            Some(
                Path::new("/home/someone")
                    .join(".local")
                    .join("share")
                    .join("rukh")
            )
        );
        assert_eq!(default_data_dir(&Fake::default(), Os::Linux), None);
    }

    #[test]
    fn a_relative_data_dir_is_made_absolute_for_the_browser() {
        let mut sys = windows().with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        sys.cwd = Some("C:/Work".to_string());
        let link = "http://127.0.0.1:47481/";
        let out = open_board(
            &sys,
            Os::Windows,
            OpenMode::Window,
            link,
            Some(Path::new("d/e")),
        );
        assert_eq!(out.opened, Opened::Window("Microsoft Edge".into()));
        let profile = Path::new("C:/Work").join("d/e").join(PROFILE_DIR);
        assert_eq!(*sys.created.borrow(), vec![profile.clone()]);
        let spawned = sys.spawned.borrow();
        assert_eq!(spawned[0].1, window_args(link, &profile));
        assert_eq!(
            norm(Path::new(&spawned[0].1[1])),
            "--user-data-dir=C:/Work/d/e/window-profile"
        );

        // When the current folder cannot be told, nothing is created and the default browser
        // is used.
        let sys = windows().with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        let out = open_board(
            &sys,
            Os::Windows,
            OpenMode::Window,
            link,
            Some(Path::new("d/e")),
        );
        assert_eq!(out.opened, Opened::DefaultBrowser);
        assert!(out.lines[0].starts_with("Could not tell where the data folder d/e is"));
        assert!(sys.created.borrow().is_empty());
        assert!(sys.spawned.borrow().is_empty());
    }

    #[test]
    fn falls_back_when_the_profile_folder_cannot_be_created() {
        let mut sys = windows().with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe");
        sys.mkdir_fails = true;
        let out = open_board(
            &sys,
            Os::Windows,
            OpenMode::Window,
            "http://x/",
            Some(Path::new("C:/Scratch/data")),
        );
        assert_eq!(out.opened, Opened::DefaultBrowser);
        assert_eq!(out.lines.len(), 2);
        assert!(out.lines[0].starts_with("Could not create the window's profile folder "));
        assert!(out.lines[0].contains("disk full"));
        assert!(out.lines[0].ends_with("so the default browser is used instead."));
        assert_eq!(out.lines[1], "Opened in your default browser.");
        assert!(
            sys.spawned.borrow().is_empty(),
            "no browser without a profile"
        );
        assert_eq!(*sys.opened_default.borrow(), vec!["http://x/".to_string()]);
    }

    #[test]
    fn window_arguments_keep_spaces_and_non_ascii_in_one_argument() {
        let profile = Path::new("C:/Users/First Last/Donn\u{e9}es de Rukh").join(PROFILE_DIR);
        let args = window_args("http://127.0.0.1:47474/", &profile);
        assert_eq!(args.len(), 9);
        assert_eq!(
            norm(Path::new(&args[1])),
            "--user-data-dir=C:/Users/First Last/Donn\u{e9}es de Rukh/window-profile"
        );
    }

    #[test]
    fn rukh_browser_that_is_not_a_program_is_reported() {
        // Missing: a line says it is not used, and the usual search goes on.
        let sys = windows()
            .with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe")
            .with_env(BROWSER_ENV, "D:/Tools/missing.exe");
        let out = open_board(
            &sys,
            Os::Windows,
            OpenMode::Window,
            "http://x/",
            Some(Path::new("C:/Scratch/data")),
        );
        assert_eq!(out.opened, Opened::Window("Microsoft Edge".into()));
        assert_eq!(out.lines.len(), 2);
        assert_eq!(
            out.lines[0],
            "RUKH_BROWSER is set to D:/Tools/missing.exe, which is not a program file, so it is \
             not used."
        );
        assert!(out.lines[1].starts_with("Opened in a Rukh window (Microsoft Edge)"));

        // Empty: treated as not set, without a line.
        let sys = windows()
            .with_file("C:/PF86/Microsoft/Edge/Application/msedge.exe")
            .with_env(BROWSER_ENV, "");
        assert_eq!(ignored_browser_env(&sys), None);
        assert_eq!(
            found(&sys, Os::Windows).map(|b| b.0),
            Some("Microsoft Edge".into())
        );

        // Only the window uses it, so only the window reports it.
        let sys = windows().with_env(BROWSER_ENV, "D:/Tools/missing.exe");
        let out = open_board(&sys, Os::Windows, OpenMode::None, "http://x/", None);
        assert_eq!(out.lines, vec![NOT_OPENED.to_string()]);
    }

    #[test]
    fn linux_skips_a_file_on_path_that_cannot_be_run() {
        let sys = Fake::default()
            .with_env("PATH", "/home/someone/bin:/usr/bin")
            .with_plain_file("/home/someone/bin/google-chrome")
            .with_file("/usr/bin/chromium");
        assert_eq!(
            found(&sys, Os::Linux),
            Some(("Chromium".into(), "/usr/bin/chromium".into()))
        );
        // The same for RUKH_BROWSER.
        let sys = Fake::default()
            .with_env("PATH", "/usr/bin")
            .with_plain_file("/opt/notes.txt")
            .with_file("/usr/bin/chromium")
            .with_env(BROWSER_ENV, "/opt/notes.txt");
        assert_eq!(found(&sys, Os::Linux).map(|b| b.0), Some("Chromium".into()));
        assert!(ignored_browser_env(&sys).is_some());
    }

    #[test]
    fn path_values_split_per_system() {
        assert_eq!(
            split_path_var(Os::Windows, OsStr::new("C:/A;;C:/B c")),
            vec![PathBuf::from("C:/A"), PathBuf::from("C:/B c")]
        );
        assert_eq!(
            split_path_var(Os::Linux, OsStr::new("/a::/b c:")),
            vec![PathBuf::from("/a"), PathBuf::from("/b c")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_folders_that_are_not_utf8_are_kept() {
        use std::os::unix::ffi::OsStrExt;
        let value = OsStr::from_bytes(b"/opt/\xffbin:/usr/bin");
        assert_eq!(
            split_path_var(Os::Linux, value),
            vec![
                PathBuf::from(OsStr::from_bytes(b"/opt/\xffbin")),
                PathBuf::from("/usr/bin")
            ]
        );
    }

    #[test]
    fn open_mode_values() {
        assert_eq!(OpenMode::parse("window"), Ok(OpenMode::Window));
        assert_eq!(OpenMode::parse("browser"), Ok(OpenMode::Browser));
        assert_eq!(OpenMode::parse("none"), Ok(OpenMode::None));
        assert_eq!(
            OpenMode::parse("tab"),
            Err("--open must be window, browser or none (got tab)".to_string())
        );
    }
}
