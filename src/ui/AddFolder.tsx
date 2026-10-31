/**
 * Adding a folder that has been chosen: Movies, TV shows or Videos, a name
 * for Videos, and the merge offer where it holds library folders already.
 * The caller scans once it is added.
 *
 * Shared by Library → Folders (the folder shown) and the desk layout's "Add a
 * folder" tile on the Library page (the folder the system's window gave),
 * so the two ask the same questions in the same words.
 */
import { useLayoutEffect, useState } from 'react';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import FocusInput from './FocusInput';
import { focusTo } from './focus';
import MergeOffer from './MergeOffer';
import { userError } from './errors';
import { KIND_WORDS } from './format';
import {
  addLibraryRoot,
  mergeLibraryRoots,
  rootsToMerge,
  type LibraryKind,
  type LibraryRoot,
} from '../library/api';
import { lastPart } from '../library/videos';

const NAME_KEY = 'folders-name';

type Step =
  | { step: 'kind' }
  | { step: 'name'; name: string }
  | { step: 'merge'; kind: LibraryKind; inside: LibraryRoot[]; name?: string };

export default function AddFolder({
  path,
  name: suggested,
  onAdded,
  onCancel,
}: {
  path: string;
  /** The name a Videos folder starts with; the folder's own if none. */
  name?: string;
  /** Added (or merged into): the name it was added under. */
  onAdded: (name: string) => void;
  onCancel: () => void;
}) {
  const [at, setAt] = useState<Step>({ step: 'kind' });
  const [error, setError] = useState<string | null>(null);

  // The ring onto the first answer the moment a question appears, as it is
  // drawn: the controls are registered by then (focusStore.ts).
  const step = at.step;
  useLayoutEffect(() => {
    if (step === 'kind') focusTo('folders-kind:movies');
    else if (step === 'name') focusTo(NAME_KEY);
  }, [step]);

  const add = async (kind: LibraryKind, name?: string) => {
    setError(null);
    try {
      const inside = await rootsToMerge(path, kind);
      if (inside.length > 0) {
        setAt({ step: 'merge', kind, inside, name });
        return;
      }
      await addLibraryRoot(path, kind, name);
      onAdded(name ?? lastPart(path));
    } catch (e) {
      setError(userError(e));
    }
  };

  const merge = async (kind: LibraryKind, name?: string) => {
    setError(null);
    try {
      await mergeLibraryRoots(path, kind, name);
      onAdded(name ?? lastPart(path));
    } catch (e) {
      setError(userError(e));
    }
  };

  return (
    <>
      {at.step === 'kind' && (
        <div className="folders-add" role="group" aria-label="Add as">
          <p>Add {path} to the library as:</p>
          <FocusGroup kind="row" className="settings-row">
            {(['movies', 'tv'] as const).map((kind) => (
              <FocusButton
                key={kind}
                focusKey={`folders-kind:${kind}`}
                className="btn-secondary"
                onSelect={() => void add(kind)}
              >
                {KIND_WORDS[kind]}
              </FocusButton>
            ))}
            <FocusButton
              focusKey="folders-kind:videos"
              className="btn-secondary"
              onSelect={() => {
                setAt({ step: 'name', name: suggested || lastPart(path) });
              }}
            >
              Videos
            </FocusButton>
            <FocusButton className="btn-secondary" onSelect={onCancel}>
              Cancel
            </FocusButton>
          </FocusGroup>
          <p className="muted">
            Movies and TV shows are matched by their names; Videos are kept as they are, for home
            videos, concerts and the rest.
          </p>
        </div>
      )}

      {at.step === 'name' && (
        <div className="folders-add">
          <p>A name for it on the Library page:</p>
          <FocusGroup kind="row" className="settings-row">
            <FocusInput
              focusKey={NAME_KEY}
              className="settings-input"
              value={at.name}
              onChange={(name) => setAt({ step: 'name', name })}
              onEnter={() => void add('videos', at.name.trim() || undefined)}
              placeholder="Home videos"
            />
            <FocusButton
              className="btn-primary"
              onSelect={() => void add('videos', at.name.trim() || undefined)}
            >
              Add
            </FocusButton>
            <FocusButton className="btn-secondary" onSelect={onCancel}>
              Cancel
            </FocusButton>
          </FocusGroup>
        </div>
      )}

      {at.step === 'merge' && (
        <MergeOffer
          offer={{ path, kind: at.kind, inside: at.inside }}
          onMerge={() => void merge(at.kind, at.name)}
          onCancel={onCancel}
        />
      )}

      {error && <p className="leave-error">{error}</p>}
    </>
  );
}
