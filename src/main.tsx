import React from 'react'
import ReactDOM from 'react-dom/client'
import './monacoLocal'
import App from './App.tsx'
import OutsideApp from './OutsideApp'
import './index.css'

class ErrorBoundary extends React.Component<any, any> {
  constructor(props: any) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error: any) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) return <div style={{color: 'red', padding: '20px'}}><h1>React Error</h1><pre>{String(this.state.error?.stack || this.state.error)}</pre></div>;
    return this.props.children;
  }
}

// Monaco cancels whatever it had in flight when an editor is disposed, and the
// resulting CancellationError escapes as an uncaught error — opening a
// whiteboard, which swaps the editor out for a canvas, produces one every time.
// Nothing has gone wrong: cancelling on teardown is the point. The whole stack
// sits inside Monaco's own dispose chain, so there is nothing to fix upstream of
// it, and leaving it to surface buries real errors in noise. Matched by name so
// only cancellations are quietened, and only ever those.
const isCancellation = (reason: unknown) => {
  const name = (reason as { name?: string })?.name;
  return name === 'Canceled' || name === 'CancellationError';
};
window.addEventListener('error', event => {
  if (isCancellation(event.error)) event.preventDefault();
});
window.addEventListener('unhandledrejection', event => {
  if (isCancellation(event.reason)) event.preventDefault();
});

// The app's window always has its token before any of this runs. Without one,
// and not in development, this is either a browser signed in to a hosted
// workspace or a browser pointed at the desktop app's private address; only the
// second is refused, and it is shown what to do instead of an editor that can
// neither load nor save.
const root = ReactDOM.createRoot(document.getElementById('root')!);
const outsideTheApp = !(window as any).__HILBERT_API_TOKEN__ && window.location.port !== '5173';
const refused = outsideTheApp
  ? fetch('/workspace/root').then(response => response.status === 401).catch(() => false)
  : Promise.resolve(false);
void refused.then(isRefused => {
  if (isRefused) {
    root.render(<OutsideApp />);
    return;
  }
  (window as any).logTiming('React mounted');
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
