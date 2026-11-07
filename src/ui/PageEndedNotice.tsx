/**
 * Says the page was started again after its process ended (pageRecovery.ts):
 * a line over whatever screen came back, for long enough to read. It takes no
 * focus and needs no answer; there is nothing the person has to do.
 */
import { useEffect, useState } from 'react';
import { pageEndedNotice } from '../player/pageRecovery';

const SHOWN_MS = 20000;

export default function PageEndedNotice() {
  const [text, setText] = useState(pageEndedNotice);
  useEffect(() => {
    if (!text) return;
    const id = window.setTimeout(() => setText(null), SHOWN_MS);
    return () => window.clearTimeout(id);
  }, [text]);
  if (!text) return null;
  return (
    <div className="page-ended-notice" role="status">
      {text}
    </div>
  );
}
