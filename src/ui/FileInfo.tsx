/**
 * The file's details on a title's page, folded away until asked for: its name,
 * folder, size, container, bitrate and languages (aboutTitle.ts), from what
 * the scan and the probe read. The text can be selected and copied.
 */
import { useEffect, useState } from 'react';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import { fileFacts } from './badges';
import { fileInfoRows, type FileInfoRow } from './aboutTitle';

interface Props {
  /** The page's area key (TitleDetail.tsx). */
  focusKey: string;
  /** The file Play would start; nothing is shown without one. */
  fileId: number | null;
  /** "film" or "episode": what the button names. */
  what: string;
}

export default function FileInfo({ focusKey, fileId, what }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ fileId: number; rows: FileInfoRow[] } | null>(null);

  useEffect(() => {
    if (!open || fileId === null) return;
    let cancelled = false;
    fileFacts(fileId)
      .then((facts) => !cancelled && facts && setRows({ fileId, rows: fileInfoRows(facts) }))
      .catch((e) => console.warn('file details not read', e));
    return () => {
      cancelled = true;
    };
  }, [open, fileId]);

  if (fileId === null) return null;
  const shown = rows?.fileId === fileId ? rows.rows : null;
  return (
    <section className="file-info">
      <FocusGroup kind="row" focusKey={focusKey}>
        <FocusButton
          className="btn-secondary"
          keepInView="nearest"
          label={`${open ? 'Hide' : 'Show'} the ${what}'s file details`}
          onSelect={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'} File details
        </FocusButton>
      </FocusGroup>
      {open && shown && (
        <dl className="file-info-list">
          {shown.map((row) => (
            <div className="file-info-row" key={row.heading}>
              <dt>{row.heading}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
