// FFmpeg sidecar preparation for Snack Meet.
//
// Builds are intentionally offline with respect to the former upstream project:
// we use a verified repository sidecar, an explicitly supplied binary, or the
// developer's local ffmpeg. No build step downloads executables from GitHub.

use std::path::{Path, PathBuf};

pub fn ensure_ffmpeg_binary() {
    let target = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .expect("Neither TARGET nor HOST environment variable is set");
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let binaries_dir = manifest_dir.join("binaries");
    let filename = if target.contains("windows") {
        format!("ffmpeg-{target}.exe")
    } else {
        format!("ffmpeg-{target}")
    };
    let destination = binaries_dir.join(filename);

    if destination.exists() && verify_ffmpeg_binary(&destination) {
        println!(
            "cargo:warning=Using verified Snack Meet FFmpeg sidecar: {}",
            destination.display()
        );
        return;
    }

    let supplied = std::env::var_os("SNACK_MEET_FFMPEG_BINARY")
        .map(PathBuf::from)
        .or_else(|| which::which("ffmpeg").ok());

    let Some(source) = supplied else {
        panic!(
            "FFmpeg sidecar is missing for {target}. Install ffmpeg or set SNACK_MEET_FFMPEG_BINARY to a trusted local binary."
        );
    };

    std::fs::create_dir_all(&binaries_dir).expect("Failed to create binaries directory");
    std::fs::copy(&source, &destination).unwrap_or_else(|error| {
        panic!(
            "Failed to copy trusted FFmpeg binary from {}: {error}",
            source.display()
        )
    });

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&destination)
            .expect("Failed to read copied FFmpeg metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&destination, permissions)
            .expect("Failed to make copied FFmpeg executable");
    }

    if !verify_ffmpeg_binary(&destination) {
        let _ = std::fs::remove_file(&destination);
        panic!("The supplied FFmpeg binary failed verification");
    }
}

fn verify_ffmpeg_binary(path: &Path) -> bool {
    std::process::Command::new(path)
        .arg("-version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}
