//! Rukh: chess boards in tabs, shown by a 3D board in the browser and playable by any AI over MCP.

mod boards;
mod cli;
mod coach;
mod http;
mod hub;
mod mcp;
mod open;
mod presence;
mod safe;
mod ws;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::boards::{FolderUse, Saver};
use crate::cli::Command;
use crate::coach::{Coach, Holding};
use crate::http::AppState;
use crate::hub::Hub;

/// Time open connections get to finish after Ctrl+C.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

pub struct Running {
    pub port: u16,
    pub hub: Arc<Hub>,
    stop: watch::Sender<bool>,
    task: JoinHandle<std::io::Result<()>>,
    saver: Option<JoinHandle<()>>,
    lock: Option<safe::Lock>,
    coach: Arc<Coach>,
}

impl Running {
    /// Stops serving, then writes what is waiting, all inside the grace period.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;

        let task = self.task;
        let _ = tokio::time::timeout_at(deadline, task).await;

        self.hub.finish_saving();
        let saved = match self.saver {
            Some(saver) => tokio::time::timeout_at(deadline, saver).await.is_ok(),
            None => true,
        };

        let coach = self.coach;
        let closing = tokio::task::spawn_blocking(move || coach.close());
        let closed = tokio::time::timeout_at(deadline, closing).await.is_ok();

        // Work still writing keeps the lock; the next start finds it stale.
        if let (true, true, Some(lock)) = (saved, closed, self.lock) {
            let _ = tokio::task::spawn_blocking(move || lock.release()).await;
        }
    }
}

/// `data_dir` None keeps the boards in memory only and writes nothing.
pub async fn start(
    listener: TcpListener,
    web_dir: PathBuf,
    data_dir: Option<PathBuf>,
) -> std::io::Result<Running> {
    let port = listener.local_addr()?.port();
    let instance = hub::new_instance_id();
    let (stop, stopped) = watch::channel(false);

    let opened = boards::open(data_dir.clone(), port, &instance).await;
    let folder_use = opened.folder_use;

    let (hub, saver, lock) = match opened.saving {
        Some((folder, lock)) => {
            let (tx, rx) = mpsc::unbounded_channel();
            let hub = Arc::new(Hub::with_desk(
                instance,
                opened.desk,
                opened.status,
                Some(tx),
            ));

            let saver = Saver::new(folder, hub.clone());
            let task = tokio::spawn(saver.run(rx, stopped.clone()));
            (hub, Some(task), Some(lock))
        }
        None => {
            let hub = Arc::new(Hub::with_desk(instance, opened.desk, opened.status, None));
            (hub, None, None)
        }
    };

    let holding = match (&data_dir, folder_use) {
        (Some(dir), FolderUse::Saving) => Holding::Ours(dir),
        (_, FolderUse::HeldBy(port)) => Holding::Another(port),
        (None, _) | (_, FolderUse::NoFolder) => Holding::NoFolder,
        (Some(_), FolderUse::Failed) => Holding::Failed,
    };

    let coach = Arc::new(Coach::new(holding, hub.clone()));

    let state = Arc::new(AppState {
        coach: coach.clone(),
        hub: hub.clone(),
        port,
        web_dir,
        next_view: AtomicU64::new(0),
        shutdown: stopped.clone(),
    });

    let (mcp_service, end_mcp_sessions) = mcp::service(hub.clone(), port);
    let app = http::router(state, mcp_service);

    tokio::spawn(presence::run_ticker(
        hub.presence().clone(),
        stopped.clone(),
    ));

    let mut on_stop = stopped;
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = on_stop.wait_for(|stopping| *stopping).await;
                end_mcp_sessions();
            })
            .await
    });

    Ok(Running {
        port,
        hub,
        stop,
        task,
        saver,
        lock,
        coach,
    })
}

async fn run(options: cli::Options) -> ExitCode {
    let web_dir = options.web_dir.clone().unwrap_or_else(cli::default_web_dir);

    let listener = match TcpListener::bind(("127.0.0.1", options.port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!(
                "rukh: could not listen on 127.0.0.1:{}: {e}. Another program (or another Rukh) may \
                 be using that port; close it or start with --port <another number>.",
                options.port
            );
            return ExitCode::FAILURE;
        }
    };

    let data_dir = options
        .data_dir
        .clone()
        .or_else(|| open::default_data_dir(&open::RealSystem, open::Os::current()))
        .map(|dir| std::path::absolute(&dir).unwrap_or(dir));

    let running = match start(listener, web_dir.clone(), data_dir.clone()).await {
        Ok(running) => running,
        Err(e) => {
            eprintln!("rukh: could not start the server: {e}");
            return ExitCode::FAILURE;
        }
    };

    let link = format!("http://127.0.0.1:{}/", running.port);
    println!("Rukh is running. Board: {link}");

    let status = running.hub.status().borrow().clone();
    match (&data_dir, status.saving) {
        (Some(dir), true) => println!("Boards are saved in {}", dir.join("boards").display()),
        (None, _) => {
            println!("Boards are not being saved: no data folder was found (pass --data-dir).")
        }
        (Some(_), false) if status.notices.is_empty() => println!("Boards are not being saved."),
        (Some(_), false) => {}
    }
    for notice in &status.notices {
        println!("{}", ascii(&notice.text));
    }

    let mode = options.open;
    let target = link.clone();
    let opened = tokio::task::spawn_blocking(move || {
        open::open_board(
            &open::RealSystem,
            open::Os::current(),
            mode,
            &target,
            data_dir.as_deref(),
        )
    })
    .await;

    match opened {
        Ok(outcome) => {
            for line in outcome.lines {
                println!("{line}");
            }
        }
        Err(e) => println!("Could not open the board ({e}); open {link} yourself."),
    }

    println!("AI clients (MCP over HTTP): {link}mcp");
    if web_dir.join("index.html").is_file() {
        println!("Board files: {}", web_dir.display());
    } else {
        println!(
            "The 3D board is not built yet (no index.html in {}). Build it with: cd web, npm ci, \
             node build.mjs --no-single",
            web_dir.display()
        );
    }

    println!("Press Ctrl+C to stop.");
    if let Err(e) = tokio::signal::ctrl_c().await {
        eprintln!("rukh: cannot listen for Ctrl+C ({e}); stopping now.");
    }

    println!("Stopping.");
    running.stop().await;
    ExitCode::SUCCESS
}

/// The console may not show other characters.
fn ascii(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{ab}' | '\u{bb}' => '"',
            c if c.is_ascii() => c,
            _ => '?',
        })
        .collect()
}

fn main() -> ExitCode {
    let command = match cli::parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(e) => {
            eprintln!("rukh: {e}\n\n{}", cli::USAGE);
            return ExitCode::from(2);
        }
    };

    let options = match command {
        Command::Help => {
            println!("{}", cli::USAGE);
            return ExitCode::SUCCESS;
        }
        Command::Version => {
            println!("rukh {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Command::Run(options) => options,
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("rukh: could not start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(run(options))
}
