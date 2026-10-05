import ReactDOM from 'react-dom/client';
import App from './App';
import { installDevLog } from './devlog';
import { loadCapabilities } from './capabilities';
import { installBackButton } from './backButton';

/**
 * Deliberately NOT wrapped in React.StrictMode.
 *
 * StrictMode double-invokes effects on mount in development. Against a native
 * FFI player that is not merely wasteful — initialising or tearing down mpv
 * twice corrupts native state and crashes the process. The safety StrictMode
 * buys is not worth it for a component whose effects own a native resource.
 */
function start(): void {
  // Installed before anything else renders, so errors during startup are caught.
  installDevLog();
  // Asked now, answered long before Leave or Settings can be opened.
  void loadCapabilities();
  void installBackButton();
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
}

// `npm run dev:mock` runs the whole UI in an ordinary browser against a fake
// library and a fake mpv — see src/dev/mockBackend.ts. Both halves of this
// condition are compile-time constants in a production build, so the mock is
// not even bundled there.
if (import.meta.env.DEV && import.meta.env.VITE_KINEMA_MOCK === '1') {
  void import('./dev/mockBackend').then(({ installMockBackend }) => {
    installMockBackend();
    start();
  });
} else {
  start();
}
