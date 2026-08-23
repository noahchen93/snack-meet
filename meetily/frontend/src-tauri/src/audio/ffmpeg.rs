use log::{debug, error, warn};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(not(windows))]
const EXECUTABLE_NAME: &str = "ffmpeg";

#[cfg(windows)]
const EXECUTABLE_NAME: &str = "ffmpeg.exe";

static FFMPEG_PATH: Lazy<Option<PathBuf>> = Lazy::new(find_ffmpeg_path_internal);

pub fn find_ffmpeg_path() -> Option<PathBuf> {
    FFMPEG_PATH.clone()
}

fn is_usable_ffmpeg(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    match Command::new(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => true,
        Ok(status) => {
            warn!(
                "Rejected FFmpeg candidate {:?}: exit status {}",
                path, status
            );
            false
        }
        Err(error) => {
            warn!("Rejected FFmpeg candidate {:?}: {}", path, error);
            false
        }
    }
}

fn checked_candidate(path: PathBuf) -> Option<PathBuf> {
    if is_usable_ffmpeg(&path) {
        debug!("Using verified FFmpeg binary: {:?}", path);
        Some(path)
    } else {
        None
    }
}

fn find_ffmpeg_path_internal() -> Option<PathBuf> {
    // Production builds package a verified sidecar next to the executable. An
    // explicit environment override is supported for development, but Snack
    // Meet never downloads or installs executable code at runtime.
    if let Ok(executable_path) = std::env::current_exe() {
        if let Some(executable_directory) = executable_path.parent() {
            if let Some(path) = checked_candidate(executable_directory.join(EXECUTABLE_NAME)) {
                return Some(path);
            }

            #[cfg(target_os = "macos")]
            if let Some(path) = checked_candidate(
                executable_directory
                    .join("../Resources")
                    .join(EXECUTABLE_NAME),
            ) {
                return Some(path);
            }
        }
    }

    if let Some(path) = std::env::var_os("SNACK_MEET_FFMPEG_BINARY") {
        if let Some(path) = checked_candidate(PathBuf::from(path)) {
            return Some(path);
        }
    }

    #[cfg(target_os = "macos")]
    for candidate in [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        if let Some(path) = checked_candidate(PathBuf::from(candidate)) {
            return Some(path);
        }
    }

    #[cfg(target_os = "linux")]
    for candidate in ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if let Some(path) = checked_candidate(PathBuf::from(candidate)) {
            return Some(path);
        }
    }

    error!(
        "No verified FFmpeg binary found. Reinstall Snack Meet or set SNACK_MEET_FFMPEG_BINARY for development"
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_binary() {
        assert!(!is_usable_ffmpeg(Path::new(
            "/path/that/does/not/exist/snack-meet-ffmpeg"
        )));
    }
}
