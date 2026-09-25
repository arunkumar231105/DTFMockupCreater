import React, { useRef, useEffect, useState } from 'react';
import { TSHIRT_SIZES, SIZE_ORDER } from '../constants/tshirtSizes';
import { drawRecoloredGarment } from '../utils/garmentTintEngine';
import './MultiSizePreview.css';

// ─── CROP UTILITY: Find non-white/non-transparent content bounds ──────────────
function getContentBounds(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, W, H);
  const d = imgData.data;
  let top = H, bottom = 0, left = W, right = 0;
  for (let y = 0; y < H; y++) {
    const rowOff = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = rowOff + x * 4;
      const a = d[i + 3];
      if (a < 10) continue;
      if (d[i] > 240 && d[i+1] > 240 && d[i+2] > 240) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top >= bottom || left >= right) return { top: 0, left: 0, w: W, h: H };
  return { top, left, w: right - left + 1, h: bottom - top + 1 };
}

function MultiSizePreview({
  artwork,
  selectedColor,
  artworkDimensions,
  artworkPosition,
  artworkScale,
  artworkAreaSettings,
  selectedSizes,
  viewSide,
  garmentLibrary,
  scalingMode,
  baseSize,
  customGarment,
  multiLayerEnabled,
  layers,
  activeLayerId,
}) {
  const cardRefs = useRef({});

  if (!selectedSizes || selectedSizes.length === 0) return null;

  // Sort selected sizes by SIZE_ORDER
  const sortedSizes = [...selectedSizes].sort(
    (a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)
  );

  // Calculate proportional scaling
  const baseSizeData = TSHIRT_SIZES[baseSize];
  const baseBodyWidth = baseSizeData ? baseSizeData.bodyWidth : 22;
  const basePercentage = (artworkDimensions.width / baseBodyWidth) * 100;

  // ─── DOWNLOAD ALL: Each card rendered at high-res, combined side by side ─────
  const handleDownloadAll = (format = 'jpeg') => {
    const numSizes = sortedSizes.length;
    if (numSizes === 0) return;

    // Use 3x scale from preview canvas (gives ~2100x2550 per card)
    const SF = 3;
    const srcW = 700, srcH = 850;

    // Render each card at high-res
    const cardImages = [];
    let maxCropW = 0, maxCropH = 0;

    sortedSizes.forEach((size) => {
      const ref = cardRefs.current[size];
      if (ref && ref.canvas) {
        // Draw directly from the preview canvas which has the correct rendering
        // Use toDataURL and reload to ensure we get pixels
        const hiRes = document.createElement('canvas');
        hiRes.width = srcW * SF; hiRes.height = srcH * SF;
        const hCtx = hiRes.getContext('2d');
        hCtx.imageSmoothingEnabled = true;
        hCtx.imageSmoothingQuality = 'high';
        hCtx.drawImage(ref.canvas, 0, 0, srcW, srcH, 0, 0, srcW * SF, srcH * SF);

        const bounds = getContentBounds(hiRes);
        if (bounds.w > maxCropW) maxCropW = bounds.w;
        if (bounds.h > maxCropH) maxCropH = bounds.h;
        cardImages.push({ canvas: hiRes, bounds, size });
      } else {
        cardImages.push(null);
      }
    });

    // Build combined canvas
    const gap = 20;
    const textH = 63;
    const totalW = numSizes * (maxCropW + gap) - gap;
    const totalH = maxCropH + textH;

    const out = document.createElement('canvas');
    out.width = totalW; out.height = totalH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    cardImages.forEach((card, idx) => {
      if (!card) return;
      const x = idx * (maxCropW + gap);
      const offX = Math.floor((maxCropW - card.bounds.w) / 2);
      const offY = Math.floor((maxCropH - card.bounds.h) / 2);
      ctx.drawImage(card.canvas, card.bounds.left, card.bounds.top, card.bounds.w, card.bounds.h, x + offX, offY, card.bounds.w, card.bounds.h);

      // Text
      const realSize = card.size.includes('_') ? card.size.split('_')[0] : card.size;
      const ref = cardRefs.current[card.size];
      const artW = ref?.artWidth || 0, artH = ref?.artHeight || 0;
      ctx.font = 'bold 40px sans-serif';
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.fillText(`${realSize} | W${artW.toFixed(1)}" H${artH.toFixed(1)}"`, x + maxCropW / 2, maxCropH + 46);
    });

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpeg' ? 0.95 : undefined;
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `mockup-all-sizes.${ext}`;
      link.href = url;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, mimeType, quality);
  };

  return (
    <div className="multi-size-preview">
      <div className="msp-header">
        <h3>Size Comparison</h3>
        <div className="msp-header-actions">
          <button className="msp-download-all-btn" onClick={() => handleDownloadAll('jpeg')} title="Download All Sizes (JPEG 95%)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download All
          </button>
          <span className="msp-mode-badge">
            {scalingMode === 'proportional' ? 'Proportional' : 'Same Size'}
          </span>
        </div>
      </div>
      <div className="msp-scroll-container">
        {sortedSizes.map((size) => (
          <MSPCard
            key={size}
            size={size}
            artwork={artwork}
            selectedColor={selectedColor}
            artworkDimensions={artworkDimensions}
            artworkPosition={artworkPosition}
            artworkScale={artworkScale}
            artworkAreaSettings={artworkAreaSettings}
            viewSide={viewSide}
            garmentLibrary={garmentLibrary}
            scalingMode={scalingMode}
            baseSize={baseSize}
            baseBodyWidth={baseBodyWidth}
            basePercentage={basePercentage}
            customGarment={customGarment}
            multiLayerEnabled={multiLayerEnabled}
            layers={layers}
            ref={(el) => { cardRefs.current[size] = el; }}
          />
        ))}
      </div>
    </div>
  );
}

const MSPCard = React.forwardRef(function MSPCard({
  size,
  artwork,
  selectedColor,
  artworkDimensions,
  artworkPosition,
  artworkScale,
  artworkAreaSettings,
  viewSide,
  garmentLibrary,
  scalingMode,
  baseSize,
  baseBodyWidth,
  basePercentage,
  customGarment,
  multiLayerEnabled,
  layers,
}, ref) {
  const canvasRef = useRef(null);
  const [tshirtImg, setTshirtImg] = useState(null);
  const [isCustomGarment, setIsCustomGarment] = useState(false);
  const [percentOverride, setPercentOverride] = useState(null); // null = use calculated

  // Handle "sameShirt" mode: size key may be "XL_1234567890" — extract real size
  const realSize = size.includes('_') ? size.split('_')[0] : size;
  const sizeData = TSHIRT_SIZES[realSize];
  if (!sizeData) return null;

  // Calculate artwork dimensions for this size
  const defaultPercent = scalingMode === 'proportional' ? basePercentage : ((artworkDimensions.width / sizeData.bodyWidth) * 100);
  const activePercent = percentOverride !== null ? percentOverride : defaultPercent;

  const sizeArtW = (sizeData.bodyWidth * activePercent) / 100;
  const aspectRatio = artworkDimensions.height / artworkDimensions.width;
  const sizeArtH = sizeArtW * aspectRatio;

  const widthPercent = activePercent.toFixed(1);

  // Expose canvas and art dimensions via ref for Download All
  React.useImperativeHandle(ref, () => ({
    canvas: canvasRef.current,
    artWidth: sizeArtW,
    artHeight: sizeArtH,
    size,
  }));

  // Load garment image. When a garment is selected (customGarment), every size
  // card must show the SAME garment type + fit — just at this card's size if a
  // matching image exists, otherwise the selected garment's own image. This
  // keeps a "Men Tank Top" comparison showing men's tanks across all sizes
  // instead of falling back to a generic tank shape.
  useEffect(() => {
    let cancelled = false;
    const applyImage = (src, custom) => {
      const img = new Image();
      img.onload = () => { if (!cancelled) { setTshirtImg(img); setIsCustomGarment(custom); } };
      img.onerror = () => {
        if (cancelled) return;
        setIsCustomGarment(false);
        const side = viewSide === 'front' ? 'front' : 'back';
        const fb = new Image();
        fb.onload = () => { if (!cancelled) setTshirtImg(fb); };
        fb.onerror = () => { if (!cancelled) setTshirtImg(null); };
        fb.src = `/tshirts/white-${side}1.png`;
      };
      img.src = src;
    };

    if (customGarment && customGarment.dataUrl) {
      // Try to find the same type + fit + THIS card's size + side in the library,
      // so each size card shows its own correctly-sized garment image.
      const custType = customGarment.type;
      const custFit = (customGarment.gender || customGarment.fit || '').toLowerCase();
      const sameKindThisSize = garmentLibrary && garmentLibrary.find((g) =>
        g.type === custType &&
        (custFit ? (g.gender || g.fit || '').toLowerCase() === custFit : true) &&
        g.size === realSize &&
        (g.side || 'front') === viewSide &&
        g.dataUrl
      );
      // Use the size-specific match, or fall back to the selected garment's image.
      applyImage((sameKindThisSize && sameKindThisSize.dataUrl) || customGarment.dataUrl, true);
      return () => { cancelled = true; };
    }

    // No garment selected — plain size+side match, then default tshirt vector.
    const taggedGarment = garmentLibrary && garmentLibrary.find(
      (g) => g.size === realSize && (g.side || 'front') === viewSide && g.dataUrl
    );
    if (taggedGarment && taggedGarment.dataUrl) {
      applyImage(taggedGarment.dataUrl, true);
    } else {
      setIsCustomGarment(false);
      const side = viewSide === 'front' ? 'front' : 'back';
      applyImage(`/tshirts/white-${side}1.png`, false);
    }
    return () => { cancelled = true; };
  }, [viewSide, selectedColor, size, realSize, garmentLibrary, customGarment]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // EXACT SAME dimensions as DesignCanvas
    const W = 700;
    const H = 850;

    ctx.clearRect(0, 0, W, H);

    let tshirtW, tshirtH, tshirtX, tshirtY;
    let pxPerInch;

    // EXACT SAME calculation as DesignCanvas getPrintArea()
    if (tshirtImg) {

      if (isCustomGarment) {
        const taggedG = garmentLibrary && garmentLibrary.find(g => g.size === realSize && (g.side || 'front') === viewSide);
        const garmentBodyWidth = taggedG?.bodyMapping?.shirtWidthInches || sizeData.bodyWidth;
        const garmentBodyHeight = taggedG?.bodyMapping?.shirtHeightInches || sizeData.bodyLength;

        const maxBodyWidth = 32;
        const maxBodyHeight = 35;
        const maxTshirtW = W * 0.52;
        const maxTshirtH = H * 0.68;
        const refPxPerInchW = maxTshirtW / maxBodyWidth;
        const refPxPerInchH = maxTshirtH / maxBodyHeight;
        pxPerInch = Math.min(refPxPerInchW, refPxPerInchH);

        tshirtW = garmentBodyWidth * pxPerInch;
        tshirtH = garmentBodyHeight * pxPerInch;
        tshirtX = (W - tshirtW) / 2;
        tshirtY = (H - tshirtH) / 2;
      } else {
        // Default t-shirt: EXACT DesignCanvas formula
        const maxBodyWidth = 32;
        const maxBodyLength = 35;
        const maxTshirtW = W * 0.52;
        const maxTshirtH = H * 0.68;
        const pxPerInchW = maxTshirtW / maxBodyWidth;
        const pxPerInchH = maxTshirtH / maxBodyLength;
        pxPerInch = Math.min(pxPerInchW, pxPerInchH);

        tshirtW = sizeData.bodyWidth * pxPerInchW;
        tshirtH = sizeData.bodyLength * pxPerInchH;
        tshirtX = (W - tshirtW) / 2;
        tshirtY = H * 0.20 + (maxTshirtH - tshirtH) / 2;
      }

      // Draw garment image — match main DesignCanvas approach
      const garImgAspect = (tshirtImg.naturalWidth || tshirtImg.width) / (tshirtImg.naturalHeight || tshirtImg.height);
      let dw, dh, dx, dy;
      if (isCustomGarment) {
        // Fit the garment image inside its mapped body box while keeping the
        // image's real aspect ratio. Drawing it straight to tshirtW×tshirtH
        // stretched non-square garments (e.g. a tank top squashed in width).
        const boxAspect = tshirtW / tshirtH;
        if (garImgAspect > boxAspect) {
          dw = tshirtW;
          dh = tshirtW / garImgAspect;
        } else {
          dh = tshirtH;
          dw = tshirtH * garImgAspect;
        }
        dx = tshirtX + (tshirtW - dw) / 2;
        dy = tshirtY + (tshirtH - dh) / 2;
      } else {
        const shirtPadding = 1.3;
        dw = tshirtW * shirtPadding;
        dh = dw / garImgAspect;
        dx = (W - dw) / 2;
        dy = tshirtY - (dh - tshirtH) * 0.15;
      }

      // Draw with color tint using V2 engine
      const offscreen = document.createElement('canvas');
      offscreen.width = W;
      offscreen.height = H;
      const offCtx = offscreen.getContext('2d');
      drawRecoloredGarment(offCtx, tshirtImg, dx, dy, dw, dh, selectedColor.hex, W, H);
      ctx.drawImage(offscreen, 0, 0);
    } else {
      // No garment image — use vector fallback
      const maxBodyWidth = 32;
      const maxTshirtW = W * 0.52;
      const maxTshirtH = H * 0.68;
      pxPerInch = Math.min(maxTshirtW / maxBodyWidth, maxTshirtH / 35);
      tshirtW = sizeData.bodyWidth * pxPerInch;
      tshirtH = sizeData.bodyLength * pxPerInch;
      tshirtX = (W - tshirtW) / 2;
      tshirtY = H * 0.20 + (maxTshirtH - tshirtH) / 2;
      drawMiniTshirt(ctx, selectedColor.hex, viewSide, tshirtX, tshirtY, tshirtW, tshirtH);
    }

    // Draw artwork — SAME logic as DesignCanvas
    // Helper to draw one artwork on this card's canvas
    const drawOneArt = (artSrc, dims, pos, opacity = 1) => {
      const img = new Image();
      img.onload = () => {
        // Same pxPerInch as the shirt
        const artPxPerInch = pxPerInch;

        // Print area — exact same as DesignCanvas
        const printAreaPxW = artworkAreaSettings.width * artPxPerInch;
        const printAreaPxH = artworkAreaSettings.height * artPxPerInch;
        const printX = tshirtX + (tshirtW - printAreaPxW) / 2;
        const printY = tshirtY + (artworkAreaSettings.topOffset * artPxPerInch);

        // Artwork dimensions — scaled for this size
        const scaledArtW = (sizeData.bodyWidth * activePercent) / 100;
        const layerAspect = dims.height / dims.width;
        const scaledArtH = scaledArtW * layerAspect;
        const artworkPxW = scaledArtW * artPxPerInch;
        const artworkPxH = scaledArtH * artPxPerInch;

        // Maintain aspect ratio — exact same as DesignCanvas
        const imgNatW = img.naturalWidth;
        const imgNatH = img.naturalHeight;
        const imgAR = imgNatW / imgNatH;
        const boxAR = artworkPxW / artworkPxH;
        let artW, artH;
        if (imgAR > boxAR) { artW = artworkPxW; artH = artworkPxW / imgAR; }
        else { artH = artworkPxH; artW = artworkPxH * imgAR; }

        // Center horizontally, align to TOP of print area vertically
        const drawX = printX + (printAreaPxW - artW) / 2 + pos.x;
        const drawY = printY + pos.y;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Clip artwork to shirt area so it doesn't overflow
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.rect(tshirtX, tshirtY, tshirtW, tshirtH);
        ctx.clip();
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, artW, artH);
        ctx.restore();
      };
      img.src = artSrc;
    };

    if (multiLayerEnabled && layers && layers.length > 0) {
      // Multi-layer mode: draw all visible layers
      layers.forEach(layer => {
        if (!layer.visible || !layer.artwork) return;
        drawOneArt(layer.artwork, layer.artworkDimensions, layer.artworkPosition, layer.opacity ?? 1);
      });
    } else if (artwork) {
      drawOneArt(artwork, artworkDimensions, artworkPosition, 1);
    }
  }, [artwork, size, selectedColor, artworkDimensions, artworkPosition, artworkScale, artworkAreaSettings, viewSide, tshirtImg, isCustomGarment, sizeArtW, sizeArtH, multiLayerEnabled, layers]);

  // Download single card — magenta background crop detection (works for white shirts)
  // ─── DOWNLOAD SINGLE CARD: Render fresh at high-res from original source ──────
  const handleDownloadSingle = () => {
    const hasContent = multiLayerEnabled
      ? (layers && layers.some(l => l.visible && l.artwork))
      : !!artwork;
    if (!hasContent) return;

    // Render at 2800x3400 (same as DesignCanvas 4x) for sharp output
    const RW = 2800, RH = 3400;
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = RW; renderCanvas.height = RH;
    const rCtx = renderCanvas.getContext('2d');
    rCtx.imageSmoothingEnabled = true;
    rCtx.imageSmoothingQuality = 'high';
    rCtx.clearRect(0, 0, RW, RH);

    // Draw garment at high-res (same logic as MSPCard draw but at 4x)
    const garmentImg = tshirtImg;
    if (!garmentImg) return;

    const garImgAspect = (garmentImg.naturalWidth || garmentImg.width) / (garmentImg.naturalHeight || garmentImg.height);
    let tshirtW, tshirtH, tshirtX, tshirtY, pxPerInch;
    const maxBodyWidth = 32, maxBodyLength = 35;
    const maxTshirtW = RW * 0.52, maxTshirtH = RH * 0.68;
    const pxPerInchW = maxTshirtW / maxBodyWidth;
    const pxPerInchH = maxTshirtH / maxBodyLength;
    pxPerInch = Math.min(pxPerInchW, pxPerInchH);

    if (isCustomGarment) {
      const taggedG = garmentLibrary && garmentLibrary.find(g => g.size === realSize && (g.side || 'front') === viewSide);
      const garmentBodyWidth = taggedG?.bodyMapping?.shirtWidthInches || sizeData.bodyWidth;
      const garmentBodyHeight = taggedG?.bodyMapping?.shirtHeightInches || sizeData.bodyLength;
      tshirtW = garmentBodyWidth * pxPerInch;
      tshirtH = garmentBodyHeight * pxPerInch;
      tshirtX = (RW - tshirtW) / 2;
      tshirtY = (RH - tshirtH) / 2;
    } else {
      tshirtW = sizeData.bodyWidth * pxPerInchW;
      tshirtH = sizeData.bodyLength * pxPerInchH;
      tshirtX = (RW - tshirtW) / 2;
      tshirtY = RH * 0.20 + (maxTshirtH - tshirtH) / 2;
    }

    // Draw garment with tint — fit inside the mapped box at the image's real
    // aspect ratio (matches the preview; avoids stretching non-square garments).
    let dw, dh, dx, dy;
    if (isCustomGarment) {
      const boxAspect = tshirtW / tshirtH;
      if (garImgAspect > boxAspect) { dw = tshirtW; dh = tshirtW / garImgAspect; }
      else { dh = tshirtH; dw = tshirtH * garImgAspect; }
      dx = tshirtX + (tshirtW - dw) / 2;
      dy = tshirtY + (tshirtH - dh) / 2;
    }
    else { const sp = 1.3; dw = tshirtW * sp; dh = dw / garImgAspect; dx = (RW - dw) / 2; dy = tshirtY - (dh - tshirtH) * 0.15; }
    drawRecoloredGarment(rCtx, garmentImg, dx, dy, dw, dh, selectedColor.hex, RW, RH);

    // Helper to draw one artwork at high-res
    const drawOneHiRes = (img, dims, pos, opacity = 1) => {
      const artPxPerInch = pxPerInch;
      const printAreaPxW = artworkAreaSettings.width * artPxPerInch;
      const printAreaPxH = artworkAreaSettings.height * artPxPerInch;
      const printX = tshirtX + (tshirtW - printAreaPxW) / 2;
      const printY = tshirtY + (artworkAreaSettings.topOffset * artPxPerInch);

      // Scale artwork dimensions for this size
      const scaledArtW = (sizeData.bodyWidth * activePercent) / 100;
      const layerAspect = dims.height / dims.width;
      const scaledArtH = scaledArtW * layerAspect;
      const artworkPxW = scaledArtW * artPxPerInch;
      const artworkPxH = scaledArtH * artPxPerInch;

      const imgAR = img.naturalWidth / img.naturalHeight;
      const boxAR = artworkPxW / artworkPxH;
      let artW, artH;
      if (imgAR > boxAR) { artW = artworkPxW; artH = artworkPxW / imgAR; }
      else { artH = artworkPxH; artW = artworkPxH * imgAR; }
      const scaleFactor = RW / 700;
      const drawX = printX + (printAreaPxW - artW) / 2 + pos.x * scaleFactor;
      const drawY = printY + pos.y * scaleFactor;
      rCtx.save();
      rCtx.globalAlpha = opacity;
      rCtx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, artW, artH);
      rCtx.restore();
    };

    // Finish rendering and trigger download
    const finishDownload = () => {
      const bounds = getContentBounds(renderCanvas);
      const cropW = bounds.w, cropH = bounds.h;
      const text = `Shirt Size: ${realSize} | Artwork Size: W ${sizeArtW.toFixed(1)}" x H ${sizeArtH.toFixed(1)}"`;
      const mCtx = document.createElement('canvas').getContext('2d');
      mCtx.font = 'bold 48px sans-serif';
      const textW = mCtx.measureText(text).width + 20;
      const finalW = Math.max(cropW, Math.ceil(textW));
      const finalH = cropH + 63;
      const dlCanvas = document.createElement('canvas');
      dlCanvas.width = finalW; dlCanvas.height = finalH;
      const dlCtx = dlCanvas.getContext('2d');
      dlCtx.fillStyle = '#ffffff';
      dlCtx.fillRect(0, 0, finalW, finalH);
      const shirtX2 = Math.floor((finalW - cropW) / 2);
      dlCtx.drawImage(renderCanvas, bounds.left, bounds.top, cropW, cropH, shirtX2, 0, cropW, cropH);
      dlCtx.font = 'bold 48px sans-serif';
      dlCtx.fillStyle = '#000000';
      dlCtx.textAlign = 'center';
      dlCtx.fillText(text, finalW / 2, cropH + 48);
      const link = document.createElement('a');
      link.download = `mockup-${realSize}.jpg`;
      link.href = dlCanvas.toDataURL('image/jpeg', 0.95);
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
    };

    // Draw artwork(s) then export
    if (multiLayerEnabled && layers && layers.length > 0) {
      // Load all visible layer images, then draw them in order
      const visibleLayers = layers.filter(l => l.visible && l.artwork);
      if (visibleLayers.length === 0) { finishDownload(); return; }
      let loaded = 0;
      const loadedImages = [];
      visibleLayers.forEach((layer, idx) => {
        const img = new Image();
        img.onload = () => {
          loadedImages[idx] = { img, layer };
          loaded++;
          if (loaded === visibleLayers.length) {
            // All loaded — draw in order
            loadedImages.forEach(({ img: lImg, layer: l }) => {
              drawOneHiRes(lImg, l.artworkDimensions, l.artworkPosition, l.opacity ?? 1);
            });
            finishDownload();
          }
        };
        img.onerror = () => {
          loaded++;
          if (loaded === visibleLayers.length) {
            loadedImages.filter(Boolean).forEach(({ img: lImg, layer: l }) => {
              drawOneHiRes(lImg, l.artworkDimensions, l.artworkPosition, l.opacity ?? 1);
            });
            finishDownload();
          }
        };
        img.src = layer.artwork;
      });
    } else {
      // Single artwork mode (original behavior)
      const artImg = new Image();
      artImg.onload = () => {
        drawOneHiRes(artImg, artworkDimensions, artworkPosition, 1);
        finishDownload();
      };
      artImg.src = artwork;
    }
  };

  return (
    <div className={`msp-card ${size === baseSize ? 'msp-card-base' : ''}`}>
      <div className="msp-canvas-wrapper">
        <canvas ref={canvasRef} width={700} height={850} className="msp-canvas" />
        <button className="msp-download-single-btn" onClick={handleDownloadSingle} title={`Download ${size} mockup`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      </div>
      <div className="msp-info">
        <div className="msp-size-label">
          {realSize}
          {size === baseSize && <span className="msp-base-tag">Base</span>}
        </div>
        <div className="msp-slider-row">
          <input
            type="range"
            min="20"
            max="95"
            step="1"
            value={Math.round(activePercent)}
            onChange={(e) => setPercentOverride(parseFloat(e.target.value))}
            className="msp-percent-slider"
          />
          <span className="msp-percent-value">{Math.round(activePercent)}%</span>
        </div>
        <div className="msp-art-dimensions">
          W {sizeArtW.toFixed(1)}" × H {sizeArtH.toFixed(1)}"
        </div>
        <div className="msp-body-info">
          Body: {sizeData.bodyWidth}" × {sizeData.bodyLength}"
        </div>
      </div>
    </div>
  );
});

function drawMiniTshirt(ctx, color, side, tshirtX, tshirtY, tshirtW, tshirtH) {
  const cx = tshirtX + tshirtW / 2;
  const shoulderY = tshirtY;
  const bodyBottom = tshirtY + tshirtH;
  const bodyLeft = tshirtX;
  const bodyRight = tshirtX + tshirtW;
  const sleeveOuterLeft = tshirtX - tshirtW * 0.18;
  const sleeveOuterRight = tshirtX + tshirtW + tshirtW * 0.18;
  const sleeveBottomY = tshirtY + tshirtH * 0.3;
  const collarWidth = tshirtW * 0.12;
  const collarDepth = side === 'front' ? tshirtH * 0.07 : tshirtH * 0.025;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.2)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(bodyLeft, sleeveBottomY);
  ctx.lineTo(sleeveOuterLeft + tshirtW * 0.04, sleeveBottomY - tshirtH * 0.05);
  ctx.lineTo(sleeveOuterLeft, shoulderY + tshirtH * 0.08);
  ctx.lineTo(bodyLeft - tshirtW * 0.02, shoulderY);
  ctx.lineTo(cx - collarWidth, shoulderY);
  ctx.quadraticCurveTo(cx, shoulderY + collarDepth, cx + collarWidth, shoulderY);
  ctx.lineTo(bodyRight + tshirtW * 0.02, shoulderY);
  ctx.lineTo(sleeveOuterRight, shoulderY + tshirtH * 0.08);
  ctx.lineTo(sleeveOuterRight - tshirtW * 0.04, sleeveBottomY - tshirtH * 0.05);
  ctx.lineTo(bodyRight, sleeveBottomY);
  ctx.lineTo(bodyRight - tshirtW * 0.01, bodyBottom);
  ctx.quadraticCurveTo(cx, bodyBottom + tshirtH * 0.01, bodyLeft + tshirtW * 0.01, bodyBottom);
  ctx.lineTo(bodyLeft, sleeveBottomY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const leftShade = ctx.createLinearGradient(bodyLeft, 0, bodyRight, 0);
  leftShade.addColorStop(0, 'rgba(0,0,0,0.06)');
  leftShade.addColorStop(0.2, 'rgba(0,0,0,0)');
  leftShade.addColorStop(0.8, 'rgba(0,0,0,0)');
  leftShade.addColorStop(1, 'rgba(0,0,0,0.06)');
  ctx.save();
  ctx.fillStyle = leftShade;
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - collarWidth, shoulderY);
  ctx.quadraticCurveTo(cx, shoulderY + collarDepth, cx + collarWidth, shoulderY);
  ctx.stroke();
}

export default MultiSizePreview;
