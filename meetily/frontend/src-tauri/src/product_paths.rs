use std::path::PathBuf;

fn migrate_subdir(base: PathBuf, subdir: &str) -> Option<PathBuf> {
    let product_root = base.join("Snack Meet");
    let product_path = product_root.join(subdir);
    let legacy_path = base.join("Meetily").join(subdir);

    if !product_path.exists() && legacy_path.exists() {
        if std::fs::create_dir_all(&product_root).is_ok() {
            match std::fs::rename(&legacy_path, &product_path) {
                Ok(()) => log::info!(
                    "Migrated legacy data directory {} to {}",
                    legacy_path.display(),
                    product_path.display()
                ),
                Err(error) => {
                    log::warn!(
                        "Could not migrate legacy data directory {}; continuing to use it: {}",
                        legacy_path.display(),
                        error
                    );
                    return Some(legacy_path);
                }
            }
        }
    }

    Some(product_path)
}

pub(crate) fn data_subdir(subdir: &str) -> Option<PathBuf> {
    let base = dirs::data_dir().or_else(dirs::home_dir)?;
    migrate_subdir(base, subdir)
}

pub(crate) fn config_subdir(subdir: &str) -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    migrate_subdir(base, subdir)
}
