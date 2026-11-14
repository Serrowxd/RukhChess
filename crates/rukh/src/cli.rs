//! Command line: `rukh [--port N] [--open window|browser|none] [--web-dir PATH] [--data-dir PATH]`.

use std::path::{Path, PathBuf};

use crate::open::OpenMode;

pub const DEFAULT_PORT: u16 = 47474;

pub const USAGE: &str = "\
Usage: rukh [--port N] [--open window|browser|none] [--web-dir PATH] [--data-dir PATH]

  --port N         Port to listen on, on 127.0.0.1 only (default 47474).
  --open MODE      How to open the board at start (default window):
                     window   its own window, in an installed Chromium-based browser
                              (Edge, Chrome, Brave, Vivaldi, Chromium) started with its
                              own profile on the high-performance graphics card where
                              the system has one; falls back to the default browser
                              when none is found. RUKH_BROWSER, set to the program
                              file of a Chromium-based browser, is tried first.
                     browser  the default browser.
                     none     do not open it; just print its link.
  --no-open        Same as --open none. When both are given, the last one wins.
  --web-dir PATH   Folder holding the built board (index.html). Defaults to web/dist
                   of the Rukh checkout, found from the program's folder or the
                   current folder.
  --data-dir PATH  Folder for the program's own files (for now only the window's
                   browser profile, created when the window first opens). Defaults to
                   %LOCALAPPDATA%\\Rukh on Windows, ~/Library/Application Support/Rukh
                   on macOS, $XDG_DATA_HOME/rukh or ~/.local/share/rukh on Linux.
  --help           Show this text.
  --version        Show the version.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub port: u16,
    pub open: OpenMode,
    pub web_dir: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Run(Options),
    Help,
    Version,
}

/// Reads the arguments after the program name. The error text says what was wrong.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Command, String> {
    let mut options = Options {
        port: DEFAULT_PORT,
        open: OpenMode::Window,
        web_dir: None,
        data_dir: None,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_string(), Some(value.to_string()))
            }
            _ => (arg.clone(), None),
        };
        if inline.is_some() && matches!(name.as_str(), "--help" | "--version" | "--no-open") {
            return Err(format!("{name} takes no value (got {arg})"));
        }
        match name.as_str() {
            "--help" | "-h" => return Ok(Command::Help),
            "--version" | "-V" => return Ok(Command::Version),
            "--no-open" => options.open = OpenMode::None,
            "--open" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--open needs one of: window, browser, none")?;
                options.open = OpenMode::parse(&value)?;
            }
            "--port" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--port needs a number, for example --port 47474")?;
                options.port = value
                    .parse::<u16>()
                    .ok()
                    .filter(|p| *p != 0)
                    .ok_or_else(|| {
                        format!("--port must be a number from 1 to 65535 (got {value})")
                    })?;
            }
            "--web-dir" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--web-dir needs a folder path")?;
                options.web_dir = Some(PathBuf::from(value));
            }
            "--data-dir" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--data-dir needs a folder path")?;
                options.data_dir = Some(PathBuf::from(value));
            }
            _ => return Err(format!("unknown argument {arg}")),
        }
    }
    Ok(Command::Run(options))
}

/// Where the built board is looked for when `--web-dir` is not given: `web/dist` beside the
/// program or in the current folder, or in a parent folder of either that is a Rukh checkout (holds
/// `web/build.mjs`), so `target/debug/rukh` finds the checkout without picking up some other
/// project's `web/dist` higher up. A folder that already holds `index.html` wins; otherwise the
/// checkout's `web/dist` (even if not built yet), so the hint page can name the right place.
pub fn default_web_dir() -> PathBuf {
    // (folder, whether it is the program's own folder or the current folder)
    let mut bases: Vec<(PathBuf, bool)> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        bases.extend(
            dir.ancestors()
                .take(5)
                .enumerate()
                .map(|(i, p)| (p.to_path_buf(), i == 0)),
        );
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.extend(
            cwd.ancestors()
                .take(4)
                .enumerate()
                .map(|(i, p)| (p.to_path_buf(), i == 0)),
        );
    }
    let dist = |base: &Path| base.join("web").join("dist");
    let is_checkout = |base: &Path| base.join("web").join("build.mjs").is_file();
    if let Some((found, _)) = bases
        .iter()
        .filter(|(base, own)| *own || is_checkout(base))
        .find(|(base, _)| dist(base).join("index.html").is_file())
    {
        return dist(found);
    }
    if let Some((checkout, _)) = bases.iter().find(|(base, _)| is_checkout(base)) {
        return dist(checkout);
    }
    std::env::current_dir()
        .map(|cwd| cwd.join("web").join("dist"))
        .unwrap_or_else(|_| PathBuf::from("web/dist"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Command, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults_and_flags() {
        assert_eq!(
            run(&[]),
            Ok(Command::Run(Options {
                port: DEFAULT_PORT,
                open: OpenMode::Window,
                web_dir: None,
                data_dir: None,
            }))
        );
        assert_eq!(
            run(&[
                "--port",
                "47481",
                "--no-open",
                "--web-dir=x/y",
                "--data-dir",
                "d/e"
            ]),
            Ok(Command::Run(Options {
                port: 47481,
                open: OpenMode::None,
                web_dir: Some(PathBuf::from("x/y")),
                data_dir: Some(PathBuf::from("d/e")),
            }))
        );
        assert!(run(&["--port", "0"]).is_err());
        assert!(run(&["--port"]).is_err());
        assert!(run(&["--bogus"]).is_err());
        assert_eq!(run(&["--help"]), Ok(Command::Help));
        assert!(run(&["--data-dir"]).is_err());
    }

    fn open_of(args: &[&str]) -> Result<OpenMode, String> {
        match run(args)? {
            Command::Run(options) => Ok(options.open),
            other => Err(format!("not a run: {other:?}")),
        }
    }

    #[test]
    fn open_values_and_the_no_open_alias() {
        assert_eq!(open_of(&[]), Ok(OpenMode::Window));
        assert_eq!(open_of(&["--open", "window"]), Ok(OpenMode::Window));
        assert_eq!(open_of(&["--open=browser"]), Ok(OpenMode::Browser));
        assert_eq!(open_of(&["--open", "none"]), Ok(OpenMode::None));
        assert_eq!(open_of(&["--no-open"]), Ok(OpenMode::None));
        // The last one given wins.
        assert_eq!(
            open_of(&["--no-open", "--open", "window"]),
            Ok(OpenMode::Window)
        );
        assert_eq!(
            open_of(&["--open", "browser", "--no-open"]),
            Ok(OpenMode::None)
        );
        assert_eq!(
            open_of(&["--open", "tab"]),
            Err("--open must be window, browser or none (got tab)".to_string())
        );
        assert_eq!(
            open_of(&["--open"]),
            Err("--open needs one of: window, browser, none".to_string())
        );
    }

    #[test]
    fn flags_without_values_refuse_one() {
        assert_eq!(
            run(&["--no-open=yes"]),
            Err("--no-open takes no value (got --no-open=yes)".to_string())
        );
        assert_eq!(
            run(&["--help=1"]),
            Err("--help takes no value (got --help=1)".to_string())
        );
        assert_eq!(
            run(&["--version=x"]),
            Err("--version takes no value (got --version=x)".to_string())
        );
        assert!(USAGE.contains("the last one wins"));
    }

    #[test]
    fn usage_names_every_flag() {
        for flag in [
            "--port",
            "--open",
            "--no-open",
            "--web-dir",
            "--data-dir",
            "--help",
            "--version",
        ] {
            assert!(USAGE.contains(flag), "usage is missing {flag}");
        }
    }
}
