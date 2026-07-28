import { useState, useRef, useEffect } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

export default function ImageEditor({ path, initialSrc, onSave }: { path: string, initialSrc: string, onSave: (buf: ArrayBuffer) => void }) {
  const [src, setSrc] = useState(initialSrc);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const imgRef = useRef<HTMLImageElement>(null);

  // URLs minted here for a rotated copy, so they can be released. The caller's
  // initialSrc has its own owner and must never be revoked from this side.
  const ownedUrls = useRef<string[]>([]);
  const showRotated = (url: string) => {
    ownedUrls.current.push(url);
    setSrc(url);
  };
  const releaseRotated = () => {
    for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    ownedUrls.current = [];
  };
  useEffect(() => releaseRotated, []);

  // When initialSrc changes (e.g. file switched, or the file was replaced on
  // disk), drop any rotation in progress and show the new image.
  useEffect(() => {
    releaseRotated();
    setSrc(initialSrc);
    setCrop(undefined);
    setCompletedCrop(undefined);
  }, [initialSrc]);

  // Rotate the image data itself and set as new src, so crop always works on an un-transformed image
  const handleRotate = async (degrees: number) => {
    if (!imgRef.current) return;
    const image = imgRef.current;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Swap dimensions for 90 or 270 deg
    if (degrees === 90 || degrees === -270 || degrees === 270 || degrees === -90) {
      canvas.width = image.naturalHeight;
      canvas.height = image.naturalWidth;
    } else {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
    if (blob) {
      showRotated(URL.createObjectURL(blob));
      setCrop(undefined); // Reset crop box after rotation
      setCompletedCrop(undefined);
    }
  };

  const handleSave = async () => {
    if (!imgRef.current) return;
    const image = imgRef.current;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;

    if (completedCrop && completedCrop.width > 0 && completedCrop.height > 0) {
      canvas.width = completedCrop.width * scaleX;
      canvas.height = completedCrop.height * scaleY;
      ctx.drawImage(
        image,
        completedCrop.x * scaleX, completedCrop.y * scaleY,
        completedCrop.width * scaleX, completedCrop.height * scaleY,
        0, 0,
        canvas.width, canvas.height
      );
    } else {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
    }

    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
    if (blob) {
      const buf = await blob.arrayBuffer();
      onSave(buf);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--panel-bg)' }}>
      <div style={{ display: 'flex', gap: '10px', padding: '10px 20px', background: 'var(--bg-color)', borderBottom: '1px solid var(--border-color)', alignItems: 'center' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-color)' }}>{path}</div>
        <div style={{ flex: 1 }}></div>
        <button className="tool-btn" onClick={() => handleRotate(-90)} title="Rotate Left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>
        </button>
        <button className="tool-btn" onClick={() => handleRotate(90)} title="Rotate Right">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>
        </button>
        <div className="toolbar-divider"></div>
        <button className="tool-btn" onClick={() => setCrop({ unit: '%', width: 50, height: 50, x: 25, y: 25 })} title="Start Cropping">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg>
        </button>
        <div className="toolbar-divider"></div>
        <button className="tool-btn primary" onClick={handleSave}>Save Changes</button>
      </div>
      
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
        <ReactCrop
          crop={crop}
          onChange={(_, percentCrop) => setCrop(percentCrop)}
          onComplete={(c) => setCompletedCrop(c)}
        >
          <img
            ref={imgRef}
            src={src}
            style={{ maxWidth: '80vw', maxHeight: 'calc(100vh - 120px)', objectFit: 'contain' }}
            crossOrigin="anonymous" // needed for toBlob if loading from API
            alt="Editor"
          />
        </ReactCrop>
      </div>
      
      <div style={{ padding: '10px 20px', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
        Click and drag on the image to crop. Use the rotate buttons above to rotate. Click Save Changes when done.
      </div>
    </div>
  );
}
