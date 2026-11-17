//! Writing files so a crash or a file held open never loses the copy in memory, and the data folder's lock.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Waits before each new try of a rename that failed.
const RENAME_RETRIES: [Duration; 4] = [
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
];

/// How long the lock check waits for the recorded owner to answer.
const HELLO_TIMEOUT: Duration = Duration::from_millis(500);

const LOCK_FILE: &str = ".lock";

/// Why a safe write did not land.
#[derive(Debug)]
pub enum WriteFailure {
    /// Another program holds the target; the new text waits in `name.pending`.
    Held,
    /// The rename failed for another reason; the new text waits in `name.pending`.
    NotReplaced(io::Error),
    Failed(io::Error),
}

impl WriteFailure {
    /// The end of "Could not save <file>: ...".
    pub fn reason(&self) -> String {
        match self {
            WriteFailure::Held => "another program has it open".to_string(),
            WriteFailure::NotReplaced(e) | WriteFailure::Failed(e) => e.to_string(),
        }
    }
}

/// A sharing or access error on a target that is not read-only: some program has it open.
fn held_by_another(path: &Path, e: &io::Error) -> bool {
    let read_only = fs::metadata(path).is_ok_and(|m| m.permissions().readonly());
    let shared = cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33));

    !read_only && (shared || e.kind() == io::ErrorKind::PermissionDenied)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

pub fn pending_path(path: &Path) -> PathBuf {
    with_suffix(path, ".pending")
}

/// Targets whose pending copy this program wrote or took in at start; no other pending copy is removed.
static OWN_PENDING: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

fn own_pending() -> std::sync::MutexGuard<'static, BTreeSet<PathBuf>> {
    OWN_PENDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Marks the pending copy of `path` as one whose text this program holds, so a later write may remove it.
pub fn adopt_pending(path: &Path) {
    own_pending().insert(path.to_path_buf());
}

/// Removes the pending copy of `path`, only when this program wrote it or took it in.
pub fn remove_pending(path: &Path) {
    if own_pending().remove(path) {
        let _ = fs::remove_file(pending_path(path));
    }
}

fn temp_path(path: &Path) -> PathBuf {
    with_suffix(path, &format!(".tmp-{}", std::process::id()))
}

/// Temp file, flush, rename over the target with retries, read back the length.
pub fn write(path: &Path, bytes: &[u8]) -> Result<(), WriteFailure> {
    write_with(path, bytes, |from, to| fs::rename(from, to))
}

pub fn write_with(
    path: &Path,
    bytes: &[u8],
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<(), WriteFailure> {
    let temp = temp_path(path);

    let written = File::create(&temp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(WriteFailure::Failed(e));
    }

    let mut last = rename(&temp, path);
    for delay in RENAME_RETRIES {
        if last.is_ok() {
            break;
        }

        std::thread::sleep(delay);
        last = rename(&temp, path);
    }

    if let Err(e) = last {
        if fs::rename(&temp, pending_path(path)).is_ok() {
            adopt_pending(path);
        }

        if held_by_another(path, &e) {
            return Err(WriteFailure::Held);
        }
        return Err(WriteFailure::NotReplaced(e));
    }

    let length = fs::metadata(path).map_err(WriteFailure::Failed)?.len();
    if length != bytes.len() as u64 {
        return Err(WriteFailure::Failed(io::Error::other(format!(
            "the file reads back as {length} bytes, not {}",
            bytes.len()
        ))));
    }

    remove_pending(path);
    Ok(())
}

/// The instance id `/api/hello` gives on `127.0.0.1:<port>`, by a GET written by hand.
pub async fn hello_instance(port: u16) -> Option<String> {
    tokio::time::timeout(HELLO_TIMEOUT, ask_hello(port))
        .await
        .ok()
        .flatten()
}

async fn ask_hello(port: u16) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;

    let request =
        format!("GET /api/hello HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.ok()?;

    let mut answer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(instance) = instance_in(&answer) {
            return Some(instance);
        }

        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 || answer.len() > 64 * 1024 {
            return instance_in(&answer);
        }
        answer.extend_from_slice(&chunk[..n]);
    }
}

fn instance_in(answer: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(answer);
    let start = text.find("\"instance\":\"")? + "\"instance\":\"".len();
    let rest = &text[start..];
    let end = rest.find('"')?;

    Some(rest[..end].to_string())
}

/// The single-writer lock on a data folder, `<data dir>/.lock`, kept open while it is held.
#[derive(Debug)]
pub struct Lock {
    path: PathBuf,
    instance: String,
    file: File,
}

#[derive(Debug)]
pub enum Locked {
    Ours(Lock),
    /// A live program on this port holds the folder.
    Held {
        port: u16,
    },
    Failed(io::Error),
}

fn lock_text(port: u16, instance: &str, started_ms: u64) -> String {
    let body = json!({
        "pid": std::process::id(),
        "port": port,
        "instance": instance,
        "started": started_ms,
    });
    format!("{body}\n")
}

/// On Windows other programs may read the open lock but neither change nor delete it.
fn create_lock(path: &Path, text: &str) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        options.share_mode(FILE_SHARE_READ);
    }

    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    Ok(file)
}

/// The recorded `(port, instance)`; `None` when the file cannot be read as a lock.
pub fn lock_owner(path: &Path) -> Option<(u16, String)> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;

    let port = u16::try_from(value.get("port")?.as_u64()?).ok()?;
    let instance = value.get("instance")?.as_str()?.to_string();
    Some((port, instance))
}

impl Lock {
    /// Takes the lock, or replaces a stale one; a live owner answering with its instance keeps it.
    pub async fn acquire(dir: &Path, port: u16, instance: &str, started_ms: u64) -> Locked {
        let path = dir.join(LOCK_FILE);
        let text = lock_text(port, instance, started_ms);

        for _ in 0..3 {
            let created = {
                let path = path.clone();
                let text = text.clone();
                tokio::task::spawn_blocking(move || create_lock(&path, &text)).await
            };

            match created {
                Ok(Ok(file)) => {
                    return Locked::Ours(Lock {
                        path,
                        instance: instance.to_string(),
                        file,
                    })
                }
                Ok(Err(e)) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Ok(Err(e)) => return Locked::Failed(e),
                Err(e) => return Locked::Failed(io::Error::other(e)),
            }

            let owner = {
                let path = path.clone();
                tokio::task::spawn_blocking(move || lock_owner(&path))
                    .await
                    .ok()
                    .flatten()
            };

            if let Some((owner_port, owner_instance)) = &owner {
                if hello_instance(*owner_port).await.as_deref() == Some(owner_instance.as_str()) {
                    return Locked::Held { port: *owner_port };
                }
            }

            let removed = {
                let path = path.clone();
                tokio::task::spawn_blocking(move || fs::remove_file(path)).await
            };

            match (removed.map_err(io::Error::other).and_then(|r| r), owner) {
                (Ok(()), _) => {}
                (Err(e), _) if e.kind() == io::ErrorKind::NotFound => {}
                (Err(_), Some((port, _))) => return Locked::Held { port },
                (Err(e), None) => return Locked::Failed(e),
            }
        }

        Locked::Failed(io::Error::other(
            "the lock file kept coming back while it was being replaced",
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Closes the lock file and removes it, only while it still names this program.
    pub fn release(self) {
        drop(self.file);

        if lock_owner(&self.path).is_some_and(|(_, instance)| instance == self.instance) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
