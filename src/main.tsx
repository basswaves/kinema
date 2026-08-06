import ReactDOM from 'react-dom/client';
import App from './App';
import { installDevLog } from './devlog';

// Installed before anything else renders, so errors during startup are caught.
installDevLog();

/**
 * Deliberately NOT wrapped in React.StrictMode.
 *
 * StrictMode double-invokes effects on mount in development. Against a native
 * FFI player that is not merely wasteful — initialising or tearing down mpv
 * twice corrupts native state and crashes the process. The safety StrictMode
 * buys is not worth it for a component whose effects own a native resource.
 */
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
