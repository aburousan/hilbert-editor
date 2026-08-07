import React from 'react'
import ReactDOM from 'react-dom/client'
import './monacoLocal'
import App from './App.tsx'
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

(window as any).logTiming('React mounted');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
