import { useEffect, useState } from 'react';
import type { NoticeKind } from '../notify';

type Toast = { id: number; message: string; kind: NoticeKind };

const COLORS: Record<NoticeKind, { bg: string; bar: string }> = {
  error: { bg: '#7f1d1d', bar: '#ef4444' },
  info: { bg: '#1e3a5f', bar: '#3b82f6' },
  success: { bg: '#14532d', bar: '#22c55e' },
};

export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    let seq = 0;
    const onNotice = (e: Event) => {
      const { message, kind } = (e as CustomEvent).detail as { message: string; kind: NoticeKind };
      const id = ++seq;
      setToasts(prev => [...prev, { id, message, kind }]);
      window.setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    };
    window.addEventListener('app-notice', onNotice);
    return () => window.removeEventListener('app-notice', onNotice);
  }, []);

  if (!toasts.length) return null;
  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
      {toasts.map(t => {
        const c = COLORS[t.kind];
        return (
          <div key={t.id} onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
            style={{
              background: c.bg, color: '#fff', borderLeft: `4px solid ${c.bar}`,
              padding: '10px 14px', borderRadius: 6, fontSize: 13, lineHeight: 1.4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.35)', cursor: 'pointer', whiteSpace: 'pre-wrap',
            }}>
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
