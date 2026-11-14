//! Rukh: one chess game, shown by a 3D board in the browser and playable by any AI over MCP.
//!
//! This program owns the game. Board pages connect to it over a WebSocket; AI clients connect to
//! `/mcp` on the same port. Everything listens on 127.0.0.1 only.

mod cli;
mod http;
mod hub;
mod mcp;
mod open;
mod presence;
mod ws;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::cli::Command;
use crate::http::AppState;
use crate::hub::Hub;

/// How long open connections get to finish after Ctrl+C before the program exits anyway.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// A server that is accepting connections.
pub struct Running {
    pub port: u16,
    pub hub: Arc<Hub>,
    stop: watch::Sender<bool>,
    task: JoinHandle<std::io::Result<()>>,
}

impl Running {
    /// Asks every connection to close and waits (up to a short grace period) for the server to end.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let task = self.task;
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, task).await;
    }
}

/// Serves Rukh on an already bound listener.
pub fn start(listener: TcpListener, web_dir: PathBuf) -> std::io::Result<Running> {
    let port = listener.local_addr()?.port();
    let hub = Arc::new(Hub::new(hub::new_instance_id()));
    let (stop, stopped) = watch::channel(false);
    let state = Arc::new(AppState {
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
    let running = match start(listener, web_dir.clone()) {
        Ok(running) => running,
        Err(e) => {
            eprintln!("rukh: could not start the server: {e}");
            return ExitCode::FAILURE;
        }
    };
    let link = format!("http://127.0.0.1:{}/", running.port);
    println!("Rukh is running. Board: {link}");
    let mode = options.open;
    let data_dir = options.data_dir.clone();
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
