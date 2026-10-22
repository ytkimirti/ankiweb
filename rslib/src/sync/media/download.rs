// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use std::collections::HashMap;
use std::io;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;

use crate::error;
use crate::error::AnkiError;
use crate::error::SyncErrorKind;
use crate::media::files::add_file_from_ankiweb;
use crate::media::files::sha1_of_data;
use crate::media::files::AddedFile;

#[derive(Debug, Serialize, Deserialize)]
pub struct DownloadFilesRequest {
    pub files: Vec<String>,
}

/// Writes the zip's files into the media folder. `expected` maps each file
/// name to the sha1 the server listed for it; if a file differs (a download
/// kept from before the server's copy changed), nothing is written and None
/// is returned, so it can be fetched again rather than recorded as synced.
pub(crate) fn extract_into_media_folder(
    media_folder: &Path,
    zip: Vec<u8>,
    expected: &HashMap<String, String>,
) -> error::Result<Option<Vec<AddedFile>>> {
    let reader = io::Cursor::new(zip);
    let mut zip = zip::ZipArchive::new(reader)?;

    let meta_file = zip.by_name("_meta")?;
    let fmap: HashMap<String, String> = serde_json::from_reader(meta_file)?;
    let mut files = Vec::with_capacity(fmap.len());

    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let name = file.name()?;
        if name == "_meta" {
            continue;
        }

        let real_name = fmap
            .get(name.as_ref())
            .ok_or_else(|| AnkiError::sync_error("malformed zip", SyncErrorKind::Other))?;

        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data)?;

        if let Some(sha1) = expected.get(real_name) {
            if !sha1.eq_ignore_ascii_case(&hex::encode(sha1_of_data(&data))) {
                return Ok(None);
            }
        }
        files.push((real_name, data));
    }

    files
        .into_iter()
        .map(|(real_name, data)| add_file_from_ankiweb(media_folder, real_name, &data))
        .collect::<error::Result<_>>()
        .map(Some)
}

#[cfg(test)]
mod test {
    use tempfile::tempdir;

    use super::*;
    use crate::sync::media::zip::zip_files_for_download;

    #[test]
    fn stale_download_writes_nothing() -> error::Result<()> {
        let dir = tempdir()?;
        let zip = || {
            zip_files_for_download(vec![
                ("a.jpg".into(), b"new".to_vec()),
                ("b.jpg".into(), b"old".to_vec()),
            ])
        };
        let sha = |data: &[u8]| hex::encode(sha1_of_data(data));

        // the server now lists different contents for b.jpg
        let expected = HashMap::from([
            ("a.jpg".to_string(), sha(b"new")),
            ("b.jpg".to_string(), sha(b"newer")),
        ]);
        assert!(extract_into_media_folder(dir.path(), zip()?, &expected)?.is_none());
        assert!(!dir.path().join("a.jpg").exists());
        assert!(!dir.path().join("b.jpg").exists());

        let expected = HashMap::from([
            ("a.jpg".to_string(), sha(b"new")),
            ("b.jpg".to_string(), sha(b"old")),
        ]);
        assert_eq!(
            extract_into_media_folder(dir.path(), zip()?, &expected)?
                .unwrap()
                .len(),
            2
        );
        assert_eq!(std::fs::read(dir.path().join("b.jpg"))?, b"old");
        Ok(())
    }
}
