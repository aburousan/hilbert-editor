import { useCallback, useEffect, useRef } from 'react';
import { derivativeOf, sampleCurve, type Curve, type View } from '../plotSampling';

export { fitY, sampleCurve, clipRun } from '../plotSampling';
export type { Curve, Sample, View } from '../plotSampling';

// The graph you drag around. It draws the same expressions the document will
// get, sampled in screen space: one sample per pixel column to start with, then
// finer where the curve bends, and a break wherever the function stops being
// finite so a pole is a gap rather than a vertical line across the picture.

export default function PlotCanvas({ curves, view, rightView, onView, height = 420, xLabel = 'x', yLabel = 'y', rightLabel = '' }: {
  curves: Curve[];
  view: View;
  // The scale for curves measured against the right-hand axis, when any are.
  rightView?: View | null;
  onView: (v: View) => void;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  rightLabel?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef(0);
  // The view is read inside pointer handlers that are bound once.
  const viewRef = useRef(view);
  viewRef.current = view;
  const usesRight = !!rightView && curves.some(c => c.visible && c.axis === 'right');

  const draw = useCallback(() => {
    const canvas = canvasRef.current, box = boxRef.current;
    if (!canvas || !box) return;
    const ratio = window.devicePixelRatio || 1;
    const w = box.clientWidth, h = height;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);

    const v = viewRef.current;
    const pad = { l: 46, r: usesRight ? 50 : 12, t: 12, b: 30 };
    const plotW = Math.max(10, w - pad.l - pad.r);
    const plotH = Math.max(10, h - pad.t - pad.b);
    const sx = (x: number) => pad.l + ((x - v.xMin) / (v.xMax - v.xMin)) * plotW;
    const sy = (y: number) => pad.t + (1 - (y - v.yMin) / (v.yMax - v.yMin)) * plotH;
    // A curve on the right-hand axis has its own scale; everything else shares
    // the left one.
    const right = rightView ?? v;
    const syRight = (y: number) => pad.t + (1 - (y - right.yMin) / (right.yMax - right.yMin)) * plotH;
    const scaleFor = (curve: Curve) => (curve.axis === 'right' && rightView ? syRight : sy);
    const viewFor = (curve: Curve) => (curve.axis === 'right' && rightView ? { ...v, yMin: right.yMin, yMax: right.yMax } : v);

    // A tick roughly every 70 pixels, on a 1/2/5 step so the numbers stay round.
    const niceStep = (span: number, target: number) => {
      const raw = span / Math.max(1, target);
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const n = raw / mag;
      return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
    };
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--text-main').trim() || '#111';
    const faint = css.getPropertyValue('--border-color').trim() || '#ccc';
    const stepX = niceStep(v.xMax - v.xMin, plotW / 70);
    const stepY = niceStep(v.yMax - v.yMin, plotH / 50);
    const label = (n: number, step: number) => {
      const places = Math.max(0, Math.min(6, -Math.floor(Math.log10(step)) + 1));
      return Number(n.toFixed(places)).toString();
    };

    g.font = '11px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.lineWidth = 1;
    for (let k = Math.ceil(v.xMin / stepX); k * stepX <= v.xMax; k++) {
      const x = sx(k * stepX);
      g.strokeStyle = faint;
      g.globalAlpha = k === 0 ? 0.85 : 0.35;
      g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + plotH); g.stroke();
      g.globalAlpha = 0.75;
      g.fillStyle = ink;
      g.fillText(label(k * stepX, stepX), x, pad.t + plotH + 6);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let k = Math.ceil(v.yMin / stepY); k * stepY <= v.yMax; k++) {
      const y = sy(k * stepY);
      g.strokeStyle = faint;
      g.globalAlpha = k === 0 ? 0.85 : 0.35;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + plotW, y); g.stroke();
      g.globalAlpha = 0.75;
      g.fillStyle = ink;
      g.fillText(label(k * stepY, stepY), pad.l - 7, y);
    }
    g.globalAlpha = 1;

    // The curves, clipped to the plotting area so a steep climb leaves the
    // picture instead of being flattened along its edge.
    g.save();
    g.beginPath();
    g.rect(pad.l, pad.t, plotW, plotH);
    g.clip();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const dashes: Record<string, number[]> = { solid: [], dashed: [6, 4], dotted: [1.5, 3] };
    for (const curve of curves) {
      if (!curve.visible || !curve.fn) continue;
      const scale = scaleFor(curve);
      const own = viewFor(curve);

      // The shaded area first, so the curve is drawn over its own shading.
      if (curve.fill && curve.fill !== 'none') {
        const from = Math.max(v.xMin, curve.fillFrom ?? v.xMin);
        const to = Math.min(v.xMax, curve.fillTo ?? v.xMax);
        if (to > from) {
          const band = { ...own, xMin: from, xMax: to };
          for (const run of sampleCurve(curve.fn, band, Math.max(20, plotW * (to - from) / (v.xMax - v.xMin)))) {
            g.beginPath();
            run.forEach((p, i) => { const X = sx(p.x), Y = scale(p.y); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
            g.lineTo(sx(run[run.length - 1].x), scale(0));
            g.lineTo(sx(run[0].x), scale(0));
            g.closePath();
            if (curve.fill === 'solid') {
              g.fillStyle = curve.colour;
              g.globalAlpha = 0.22;
              g.fill();
              g.globalAlpha = 1;
            } else {
              // Hatching, drawn as lines through the region rather than as a
              // flat wash, which is what the printed figure does too.
              g.save();
              g.clip();
              g.strokeStyle = curve.colour;
              g.globalAlpha = 0.75;
              g.lineWidth = 0.8;
              const step = 7;
              for (let d = -plotH; d < plotW + plotH; d += step) {
                g.beginPath(); g.moveTo(pad.l + d, pad.t + plotH); g.lineTo(pad.l + d + plotH, pad.t); g.stroke();
                if (curve.fill === 'cross') { g.beginPath(); g.moveTo(pad.l + d, pad.t); g.lineTo(pad.l + d + plotH, pad.t + plotH); g.stroke(); }
              }
              g.globalAlpha = 1;
              g.restore();
            }
          }
        }
      }

      g.strokeStyle = curve.colour;
      g.lineWidth = 1.8;
      g.setLineDash(dashes[curve.dash ?? 'solid']);
      for (const run of sampleCurve(curve.fn, own, plotW)) {
        g.beginPath();
        run.forEach((p, i) => { const X = sx(p.x), Y = scale(p.y); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
        g.stroke();
      }

      // f′(x), in the same colour and always dashed, as in the figure.
      if (curve.derivative) {
        g.setLineDash([5, 4]);
        g.lineWidth = 1.2;
        g.globalAlpha = 0.85;
        for (const run of sampleCurve(derivativeOf(curve.fn, own), own, plotW)) {
          g.beginPath();
          run.forEach((p, i) => { const X = sx(p.x), Y = scale(p.y); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
          g.stroke();
        }
        g.globalAlpha = 1;
      }
      g.setLineDash([]);
    }
    g.restore();

    // The right-hand axis, when something is measured against it.
    if (usesRight && rightView) {
      const stepR = niceStep(rightView.yMax - rightView.yMin, plotH / 50);
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.globalAlpha = 0.75;
      g.fillStyle = ink;
      for (let k = Math.ceil(rightView.yMin / stepR); k * stepR <= rightView.yMax; k++) {
        const y = syRight(k * stepR);
        g.fillText(label(k * stepR, stepR), pad.l + plotW + 7, y);
      }
      if (rightLabel) {
        g.save();
        g.translate(w - 4, pad.t + plotH / 2);
        g.rotate(Math.PI / 2);
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText(rightLabel, 0, 0);
        g.restore();
      }
      g.globalAlpha = 1;
    }

    // Axis frame and names.
    g.strokeStyle = faint;
    g.globalAlpha = 0.9;
    g.strokeRect(pad.l, pad.t, plotW, plotH);
    g.globalAlpha = 0.7;
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText(xLabel, pad.l + plotW / 2, h - 2);
    g.save();
    g.translate(11, pad.t + plotH / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'top';
    g.fillText(yLabel, 0, 0);
    g.restore();
    g.globalAlpha = 1;
  }, [curves, height, xLabel, yLabel, rightView, rightLabel, usesRight]);

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame.current);
  }, [draw, view]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { frame.current = requestAnimationFrame(draw); });
    observer.observe(box);
    return () => observer.disconnect();
  }, [draw]);

  // Dragging moves the view under the pointer: the point you grabbed stays
  // under it, as on a map.
  const dragging = useRef<{ x: number; y: number; view: View } | null>(null);
  const plotBox = () => {
    const box = boxRef.current!;
    return { w: box.clientWidth - 58, h: height - 42, left: 46, top: 12 };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragging.current = { x: e.clientX, y: e.clientY, view: viewRef.current };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = dragging.current;
    if (!start) return;
    const { w, h } = plotBox();
    const v = start.view;
    const dx = ((e.clientX - start.x) / w) * (v.xMax - v.xMin);
    const dy = ((e.clientY - start.y) / h) * (v.yMax - v.yMin);
    onView({ xMin: v.xMin - dx, xMax: v.xMax - dx, yMin: v.yMin + dy, yMax: v.yMax + dy });
  };
  const stopDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragging.current = null;
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch {}
  };

  // Zoom around the pointer. Shift zooms x alone, Alt zooms y alone, so an
  // axis can be stretched without touching the other.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const { w, h, left, top } = plotBox();
      const rect = canvas.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - rect.left - left) / w));
      const fy = Math.min(1, Math.max(0, (e.clientY - rect.top - top) / h));
      const at = { x: v.xMin + fx * (v.xMax - v.xMin), y: v.yMax - fy * (v.yMax - v.yMin) };
      const factor = Math.exp(e.deltaY * 0.0016);
      const kx = e.altKey ? 1 : factor;
      const ky = e.shiftKey ? 1 : factor;
      onView({
        xMin: at.x - (at.x - v.xMin) * kx,
        xMax: at.x + (v.xMax - at.x) * kx,
        yMin: at.y - (at.y - v.yMin) * ky,
        yMax: at.y + (v.yMax - at.y) * ky,
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onView, height]);

  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: dragging.current ? 'grabbing' : 'grab', touchAction: 'none', borderRadius: 6 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onDoubleClick={() => onView({ xMin: -6.3, xMax: 6.3, yMin: -2.2, yMax: 2.2 })}
      />
    </div>
  );
}

