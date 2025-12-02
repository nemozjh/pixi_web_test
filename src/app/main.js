// src/app/main.js
import { loadOverlay } from '../data/overlayLoader.js';

async function init() {
  const logEl = document.getElementById('log');
  const containerEl = document.getElementById('canvas-container');

  // Sidebar UI
  const chkDots     = document.getElementById('chk-dots');
  const chkLabels   = document.getElementById('chk-labels');
  const chkRect     = document.getElementById('chk-rect');
  const chkSpeed    = document.getElementById('chk-speed');
  const chkProjRect = document.getElementById('chk-proj-rect');
  const chkSmooth   = document.getElementById('chk-smooth');

  const btnCamWide  = document.getElementById('btn-cam-wide');
  const btnCamTrack = document.getElementById('btn-cam-track');
  const btnPlay     = document.getElementById('btn-play');

  // Timeline / markers UI
  const timelineScrubber  = document.getElementById('timeline-scrubber');
  const timelineMarkersEl = document.getElementById('timeline-markers');
  const btnAddMarker      = document.getElementById('btn-add-marker');
  const markerListEl      = document.getElementById('marker-list');

  const layerState = {
    dots:     false,
    labels:   false,
    rect:     false,
    speed:    false,
    projRect: false
  };

  let markers = [];     // { id, timeSec, cameraId, layers, hasTriggered }
  let nextMarkerId = 1;

  // Smoothing (positions + camera follow)
  let smoothingEnabled = true;
  const smoothAlpha = 0.15;          // athlete position
  const cameraFollowAlpha = 0.08;    // camera offX
  const smoothedPosById = new Map(); // id -> {x,y}
  let cameraFollowOffX = 0;          // smoothed offX for track mode

  // For marker auto-trigger robustness
  let prevTimeSec = 0;

  logEl.textContent = 'Loading overlay_data_sample.json ...';

  // 1) Load overlay data
  const overlay = await loadOverlay('./assets/overlay_data_sample.json');
  logEl.textContent = `Overlay loaded. Frames: ${overlay.frames.length}`;
  console.log('Overlay loaded:', overlay);
  console.log('Frame 0:', overlay.getFrameByIndex(0));

  const videoInfo = overlay.raw.video || {};
  const videoW = videoInfo.width || 1920;
  const videoH = videoInfo.height || 1080;

  // 1.1 baselineY per athlete (stable vertical)
  const baselineYById = new Map();
  {
    const acc = new Map(); // id -> {sum, count}
    (overlay.frames || []).forEach(frame => {
      const arr = frame.athletes || frame.lanes || [];
      arr.forEach(a => {
        const rawY = (typeof a.y === 'number' ? a.y
                    : typeof a.cy === 'number' ? a.cy
                    : null);
        if (rawY == null) return;
        let s = acc.get(a.id);
        if (!s) {
          s = { sum: 0, count: 0 };
          acc.set(a.id, s);
        }
        s.sum += rawY;
        s.count += 1;
      });
    });
    acc.forEach((v, id) => {
      if (v.count > 0) {
        baselineYById.set(id, v.sum / v.count);
      }
    });
    console.log('baselineYById:', baselineYById);
  }

  // 2) Pixi App
  const app = new PIXI.Application({
    resizeTo: containerEl,
    backgroundColor: 0x000000,
    antialias: true
  });
  containerEl.appendChild(app.view);

  // 3) Hidden <video> as texture
  const videoEl = document.createElement('video');
  videoEl.src = './assets/sample_fast_h264.mp4';
  videoEl.muted = true;
  videoEl.loop = true;
  videoEl.playsInline = true;
  videoEl.crossOrigin = 'anonymous';

  let videoTexture = null;
  let videoSprite  = null;
  let videoReady   = false;
  let videoDuration = 20;
  let isScrubbing   = false;

  // 4) Camera presets
  const defaultShot = {
    zoom: 1.0,
    offX: 0.0,
    offY: 0.0,
    ltx: 0.0,
    lty: 0.0,
    rtx: 1.0,
    rty: 0.0,
    rbx: 1.0,
    rby: 1.0,
    lbx: 0.0,
    lby: 1.0
  };

  // Base track shot (no follow yet)
  const baseTrackShot = {
    zoom: 1.85,
    offX: 0.0,
    offY: 0.0,
    ltx: 0.2,
    lty: 0.05,
    rtx: 1.1,
    rty: 0.0,
    rbx: 1.0,
    rby: 1.0,
    lbx: 0.05,
    lby: 0.96
  };

  let currentShotId    = 'wide';         // 'wide' | 'track'
  let currentShotState = { ...defaultShot };

  let camAnimating   = false;
  let camFrom        = null;
  let camTo          = null;
  let camAnimStart   = 0;
  const camAnimDuration = 320; // ms

  // 5) Overlay containers
  const overlayLayer = new PIXI.Container();
  app.stage.addChild(overlayLayer);

  const athleteGraphics = new Map();

  overlay.athletes.forEach(meta => {
    const container = new PIXI.Container();

    // Rectangle: behind swimmer
    const rect = new PIXI.Graphics();
    rect.beginFill(laneColor(meta.id), 0.9);
    rect.drawRect(-90, -16, 80, 32);
    rect.endFill();

    const dot = new PIXI.Graphics();
    dot.beginFill(laneColor(meta.id));
    dot.drawCircle(0, 0, 6);
    dot.endFill();
    dot.alpha = 0.95;

    const label = new PIXI.Text(String(meta.id), {
      fontSize: 10,
      fill: 0xffffff
    });
    label.anchor.set(0, 0.5);
    label.position.set(8, 0);

    const speedText = new PIXI.Text('', {
      fontSize: 14,
      fill: 0xfffbeb,
      fontWeight: '600',
      fontFamily: 'system-ui'
    });
    speedText.anchor.set(0.5, 0.5);
    speedText.position.set(0, -22);

    container.addChild(rect);
    container.addChild(dot);
    container.addChild(label);
    container.addChild(speedText);

    overlayLayer.addChild(container);

    // Projection rectangle
    const projRect = new PIXI.Graphics();
    overlayLayer.addChild(projRect);

    athleteGraphics.set(meta.id, {
      container,
      dot,
      label,
      rect,
      speedText,
      projRect
    });
  });

  function laneColor(id) {
    const colors = [
      0xff4b4b,
      0xff9f1c,
      0x2ec4b6,
      0x00b4d8,
      0x4361ee,
      0x7209b7,
      0xf72585,
      0x8ac926
    ];
    if (id == null) return 0xffffff;
    const idx = (Number(id) - 1 + colors.length) % colors.length;
    return colors[idx];
  }

  function applyLayerVisibility() {
    for (const entry of athleteGraphics.values()) {
      const { container, dot, label, rect, speedText, projRect } = entry;

      dot.visible       = layerState.dots;
      label.visible     = layerState.labels;
      rect.visible      = layerState.rect;
      speedText.visible = layerState.speed;
      projRect.visible  = layerState.projRect;

      container.visible =
        layerState.dots || layerState.labels || layerState.rect || layerState.speed;
    }
  }
  applyLayerVisibility();

  // 6) Video texture + Sprite2d
  videoEl.addEventListener('loadedmetadata', () => {
    if (videoEl.duration && !Number.isNaN(videoEl.duration)) {
      videoDuration = videoEl.duration;
      timelineScrubber.max = String(videoDuration);
    }
  });

  videoEl.addEventListener('loadeddata', () => {
    if (!videoTexture) {
      videoTexture = PIXI.Texture.from(videoEl);
    } else {
      videoTexture.baseTexture.resource.source = videoEl;
    }

    if (!videoSprite) {
      const Sprite2d = PIXI.projection.Sprite2d;
      videoSprite = new Sprite2d(videoTexture);
      app.stage.addChildAt(videoSprite, 0);
    }

    videoReady = true;
    applyShotStateToSprite(defaultShot);
    currentShotState = { ...defaultShot };

    videoEl.play().catch(() => {});
    btnPlay.textContent = 'Pause';
  });

  // 7) Camera application & projection helpers

  function applyShotStateToSprite(state) {
    currentShotState = { ...state };
    if (!videoSprite) return;

    const vw = app.renderer.width;
    const vh = app.renderer.height;

    videoSprite.x = 0;
    videoSprite.y = 0;
    videoSprite.width  = vw;
    videoSprite.height = vh;

    const pLT = new PIXI.Point(state.ltx * vw, state.lty * vh);
    const pRT = new PIXI.Point(state.rtx * vw, state.rty * vh);
    const pRB = new PIXI.Point(state.rbx * vw, state.rby * vh);
    const pLB = new PIXI.Point(state.lbx * vw, state.lby * vh);

    videoSprite.proj.affine = PIXI.projection.AFFINE.NONE;
    videoSprite.proj.mapSprite(videoSprite, [pLT, pRT, pRB, pLB]);

    const zoom = state.zoom;
    const offX = state.offX || 0;
    const offY = state.offY || 0;
    const centerX = vw / 2;
    const centerY = vh / 2;
    const maxPanX = vw * 0.5;
    const maxPanY = vh * 0.5;
    const panX = offX * maxPanX;
    const panY = offY * maxPanY;

    videoSprite.scale.set(zoom);
    videoSprite.position.set(
      panX + (1 - zoom) * centerX,
      panY + (1 - zoom) * centerY
    );
  }

  // Project video-space point with explicit shot
  function projectPointWithShot(xPix, yPix, shot) {
    const vw = app.renderer.width;
    const vh = app.renderer.height;
    if (!vw || !vh) return { cx: 0, cy: 0 };

    const s = shot;

    const nx = xPix / videoW;
    const ny = yPix / videoH;

    const LT = { x: s.ltx * vw, y: s.lty * vh };
    const RT = { x: s.rtx * vw, y: s.rty * vh };
    const LB = { x: s.lbx * vw, y: s.lby * vh };
    const RB = { x: s.rbx * vw, y: s.rby * vh };

    const topX = LT.x + (RT.x - LT.x) * nx;
    const topY = LT.y + (RT.y - LT.y) * nx;
    const botX = LB.x + (RB.x - LB.x) * nx;
    const botY = LB.y + (RB.y - LB.y) * nx;

    let cx = topX + (botX - topX) * ny;
    let cy = topY + (botY - topY) * ny;

    const zoom = s.zoom;
    const offX = s.offX || 0;
    const offY = s.offY || 0;
    const centerX = vw / 2;
    const centerY = vh / 2;
    const maxPanX = vw * 0.5;
    const maxPanY = vh * 0.5;
    const panX = offX * maxPanX;
    const panY = offY * maxPanY;

    cx = (cx - centerX) * zoom + centerX + panX;
    cy = (cy - centerY) * zoom + centerY + panY;

    return { cx, cy };
  }

  // Project with current shot
  function projectPointFromCurrentShot(xPix, yPix) {
    return projectPointWithShot(xPix, yPix, currentShotState);
  }

  // 8) Camera animation for preset transitions

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animateShotTo(targetState) {
    if (!videoSprite) {
      applyShotStateToSprite(targetState);
      return;
    }
    camFrom = { ...currentShotState };
    camTo   = { ...targetState };
    camAnimStart = performance.now();
    camAnimating = true;
  }

  function updateCameraAnimation(now) {
    if (!camAnimating || !camFrom || !camTo) return;

    const t = Math.min((now - camAnimStart) / camAnimDuration, 1);
    const e = easeOutCubic(t);

    const inter = {};
    Object.keys(camFrom).forEach(k => {
      inter[k] = camFrom[k] + (camTo[k] - camFrom[k]) * e;
    });

    applyShotStateToSprite(inter);

    if (t >= 1) {
      camAnimating = false;
      applyShotStateToSprite(camTo);
    }
  }

  function updateCameraButtons(id) {
    const wideActive = id === 'wide';
    btnCamWide.classList.toggle('active', wideActive);
    btnCamTrack.classList.toggle('active', !wideActive);
  }

  // 9) Smoothing helpers

  function getSmoothedPos(id, rawX, rawY) {
    if (!smoothingEnabled) {
      const v = { x: rawX, y: rawY };
      smoothedPosById.set(id, v);
      return v;
    }
    const prev = smoothedPosById.get(id);
    if (!prev) {
      const v = { x: rawX, y: rawY };
      smoothedPosById.set(id, v);
      return v;
    }
    const x = prev.x + smoothAlpha * (rawX - prev.x);
    const y = prev.y + smoothAlpha * (rawY - prev.y);
    const v = { x, y };
    smoothedPosById.set(id, v);
    return v;
  }

  function resetSmoothing() {
    smoothedPosById.clear();
    // keep cameraFollowOffX to avoid camera jump
  }

  // 10) Compute target track shot at a given time (used when switching to track)

  function computeTrackShotAtTime(timeSec) {
    // If no overlay/frame info, fallback to baseTrackShot
    const frame = overlay.getFrameByTime(timeSec);
    if (!frame) return { ...baseTrackShot, offX: 0.0 };

    const arr = frame.athletes || frame.lanes || [];

    let rawX4 = null;
    let rawY4 = null;
    for (const a of arr) {
      if (a.id === 4) {
        const rawY = (typeof a.y === 'number' ? a.y
                    : typeof a.cy === 'number' ? a.cy
                    : 0);
        const yBaseline = baselineYById.get(a.id) ?? rawY;
        const xRaw = a.x ?? a.cx ?? 0;
        rawX4 = xRaw;
        rawY4 = yBaseline;
        break;
      }
    }
    if (rawX4 == null) {
      return { ...baseTrackShot, offX: 0.0 };
    }

    // Optionally warm smoothing for lane 4 so that overlay + camera are consistent
    const pos4 = getSmoothedPos(4, rawX4, rawY4);

    const vw = app.renderer.width;
    const centerX = vw / 2;
    const maxPanX = vw * 0.5;

    const shotNoPan = { ...baseTrackShot, offX: 0.0 };
    const pNoPan = projectPointWithShot(pos4.x, pos4.y, shotNoPan);

    const deltaX = centerX - pNoPan.cx;
    let desiredOffX = 0;
    if (maxPanX > 1e-3) {
      desiredOffX = deltaX / maxPanX;
      if (desiredOffX >  1.2) desiredOffX =  1.2;
      if (desiredOffX < -1.2) desiredOffX = -1.2;
    }

    return { ...baseTrackShot, offX: desiredOffX };
  }

  // 11) Track camera follow per-frame（继续微调 offX）

  function updateTrackCameraFollow(lane4XPix, lane4YPix) {
    if (!videoReady) return;

    const vw = app.renderer.width;
    const centerX = vw / 2;
    const maxPanX = vw * 0.5;

    const shotNoPan = { ...baseTrackShot, offX: 0.0 };
    const pNoPan = projectPointWithShot(lane4XPix, lane4YPix, shotNoPan);
    const deltaX = centerX - pNoPan.cx;

    let desiredOffX = 0;
    if (maxPanX > 1e-3) {
      desiredOffX = deltaX / maxPanX;
      if (desiredOffX >  1.2) desiredOffX =  1.2;
      if (desiredOffX < -1.2) desiredOffX = -1.2;
    }

    if (smoothingEnabled) {
      cameraFollowOffX =
        cameraFollowOffX + cameraFollowAlpha * (desiredOffX - cameraFollowOffX);
    } else {
      cameraFollowOffX = desiredOffX;
    }

    const shotWithFollow = {
      ...baseTrackShot,
      offX: cameraFollowOffX
    };
    applyShotStateToSprite(shotWithFollow);
  }

  // 12) Overlay update + camera + markers

  function updateOverlayForTime(t, now) {
    if (!videoReady) return;

    checkAndApplyMarkers(t);

    // Preset camera animation (wide <-> track)
    updateCameraAnimation(now);

    const frame = overlay.getFrameByTime(t);
    if (!frame) {
      prevTimeSec = t;
      return;
    }

    const arr = frame.athletes || frame.lanes || [];

    // Pre-pass: lane 4 pos for camera follow
    let lane4Smoothed = null;
    {
      let rawX4 = null;
      let rawY4 = null;
      for (const a of arr) {
        if (a.id === 4) {
          const rawY = (typeof a.y === 'number' ? a.y
                      : typeof a.cy === 'number' ? a.cy
                      : 0);
          const yBaseline = baselineYById.get(a.id) ?? rawY;
          const xRaw = a.x ?? a.cx ?? 0;
          rawX4 = xRaw;
          rawY4 = yBaseline;
          break;
        }
      }
      if (rawX4 != null && rawY4 != null) {
        lane4Smoothed = getSmoothedPos(4, rawX4, rawY4);
      }
    }

    // In track mode & not during preset transition, apply follow
    if (!camAnimating && currentShotId === 'track' && lane4Smoothed) {
      updateTrackCameraFollow(lane4Smoothed.x, lane4Smoothed.y);
    }

    // Main overlay loop
    for (const a of arr) {
      const entry = athleteGraphics.get(a.id);
      if (!entry) continue;
      const { container, speedText, projRect } = entry;

      const rawY = (typeof a.y === 'number' ? a.y
                  : typeof a.cy === 'number' ? a.cy
                  : 0);
      const xRaw = a.x ?? a.cx ?? 0;
      const yBaseline = baselineYById.get(a.id) ?? rawY;

      let pos;
      if (a.id === 4 && lane4Smoothed) {
        pos = lane4Smoothed;
      } else {
        pos = getSmoothedPos(a.id, xRaw, yBaseline);
      }

      const { cx, cy } = projectPointFromCurrentShot(pos.x, pos.y);
      container.position.set(cx, cy);

      // Speed text
      let speedVal = null;
      if (typeof a.speed_mps === 'number') speedVal = a.speed_mps;
      else if (typeof a.speed === 'number') speedVal = a.speed;
      else if (typeof a.speed_smooth === 'number') speedVal = a.speed_smooth;
      else if (typeof a.speed_px_per_s === 'number') speedVal = a.speed_px_per_s;

      if (speedVal != null) {
        speedText.text = speedVal.toFixed(2) + ' m/s';
      } else {
        speedText.text = '';
      }

      // Projection rectangle
      projRect.clear();
      if (layerState.projRect) {
        const rectWidthPx  = 220;
        const rectHeightPx = 60;

        const centerXPix = pos.x + rectWidthPx * 0.6;
        const centerYPix = pos.y;

        const halfW = rectWidthPx / 2;
        const halfH = rectHeightPx / 2;

        const tlPix = { x: centerXPix - halfW, y: centerYPix - halfH };
        const trPix = { x: centerXPix + halfW, y: centerYPix - halfH };
        const brPix = { x: centerXPix + halfW, y: centerYPix + halfH };
        const blPix = { x: centerXPix - halfW, y: centerYPix + halfH };

        const tl = projectPointFromCurrentShot(tlPix.x, tlPix.y);
        const tr = projectPointFromCurrentShot(trPix.x, trPix.y);
        const br = projectPointFromCurrentShot(brPix.x, brPix.y);
        const bl = projectPointFromCurrentShot(blPix.x, blPix.y);

        projRect.beginFill(laneColor(a.id), 0.55);
        projRect.drawPolygon([
          tl.cx, tl.cy,
          tr.cx, tr.cy,
          br.cx, br.cy,
          bl.cx, bl.cy
        ]);
        projRect.endFill();
      }
    }

    prevTimeSec = t;
  }

  // 13) Frame loop

  function startOverlayLoop() {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const cb = (now, metadata) => {
        const t = metadata?.mediaTime ?? videoEl.currentTime ?? 0;

        if (!isScrubbing) {
          timelineScrubber.value = t.toFixed(2);
        }

        updateOverlayForTime(t, now);
        videoEl.requestVideoFrameCallback(cb);
      };
      videoEl.requestVideoFrameCallback(cb);
    } else {
      const loop = (now) => {
        const t = videoEl.currentTime || 0;
        if (!isScrubbing) {
          timelineScrubber.value = t.toFixed(2);
        }
        updateOverlayForTime(t, now || performance.now());
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  // 14) Timeline scrubbing

  timelineScrubber.addEventListener('input', () => {
    isScrubbing = true;
    const t = parseFloat(timelineScrubber.value) || 0;
    videoEl.currentTime = t;
  });

  timelineScrubber.addEventListener('change', () => {
    isScrubbing = false;
  });

  // 15) Marker management + auto trigger

  function formatTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  }

  function refreshTimelineMarkers() {
    timelineMarkersEl.innerHTML = '';
    if (!videoDuration || !markers.length) return;

    markers.forEach(m => {
      const ratio = m.timeSec / videoDuration;
      const tick = document.createElement('div');
      tick.className = 'marker-tick';
      tick.style.left = `${ratio * 100}%`;
      timelineMarkersEl.appendChild(tick);
    });
  }

  function refreshMarkerList() {
    markerListEl.innerHTML = '';

    markers
      .slice()
      .sort((a, b) => a.timeSec - b.timeSec)
      .forEach(m => {
        const li = document.createElement('li');
        li.dataset.id = String(m.id);

        const info = document.createElement('div');
        info.className = 'marker-info';

        const timeSpan = document.createElement('div');
        timeSpan.className = 'marker-time';
        timeSpan.textContent = formatTime(m.timeSec);

        const metaSpan = document.createElement('div');
        metaSpan.className = 'marker-meta';
        const layersDesc = [];
        if (m.layers.dots)     layersDesc.push('dots');
        if (m.layers.labels)   layersDesc.push('labels');
        if (m.layers.rect)     layersDesc.push('rect');
        if (m.layers.speed)    layersDesc.push('speed');
        if (m.layers.projRect) layersDesc.push('projRect');
        metaSpan.textContent =
          `Cam: ${m.cameraId}, Layers: ${layersDesc.join(' ') || 'none'}`;

        info.appendChild(timeSpan);
        info.appendChild(metaSpan);

        const actions = document.createElement('div');
        actions.className = 'marker-actions';

        const btnJump = document.createElement('button');
        btnJump.className = 'marker-btn';
        btnJump.textContent = 'Jump';
        btnJump.addEventListener('click', () => applyMarker(m.id, { auto: false }));

        const btnDelete = document.createElement('button');
        btnDelete.className = 'marker-btn';
        btnDelete.textContent = 'Del';
        btnDelete.addEventListener('click', () => {
          markers = markers.filter(mm => mm.id !== m.id);
          refreshTimelineMarkers();
          refreshMarkerList();
        });

        actions.appendChild(btnJump);
        actions.appendChild(btnDelete);

        li.appendChild(info);
        li.appendChild(actions);
        markerListEl.appendChild(li);
      });
  }

  function addMarkerAtCurrentTime() {
    const t = videoEl.currentTime || 0;

    const marker = {
      id: nextMarkerId++,
      timeSec: t,
      cameraId: currentShotId,
      layers: {
        dots:     layerState.dots,
        labels:   layerState.labels,
        rect:     layerState.rect,
        speed:    layerState.speed,
        projRect: layerState.projRect
      },
      hasTriggered: false
    };

    markers.push(marker);
    refreshTimelineMarkers();
    refreshMarkerList();
    console.log('Marker added:', marker);
  }

  function applyMarker(id, opts = {}) {
    const m = markers.find(mm => mm.id === id);
    if (!m) return;

    // Manual jump should seek
    if (!opts.auto) {
      videoEl.currentTime = m.timeSec;
      timelineScrubber.value = m.timeSec.toFixed(2);
      prevTimeSec = m.timeSec;
    }

    // Layers
    layerState.dots     = m.layers.dots;
    layerState.labels   = m.layers.labels;
    layerState.rect     = m.layers.rect;
    layerState.speed    = m.layers.speed;
    layerState.projRect = m.layers.projRect;

    chkDots.checked     = layerState.dots;
    chkLabels.checked   = layerState.labels;
    chkRect.checked     = layerState.rect;
    chkSpeed.checked    = layerState.speed;
    chkProjRect.checked = layerState.projRect;

    applyLayerVisibility();

    // Camera
    if (m.cameraId === 'track') {
      currentShotId = 'track';
      updateCameraButtons('track');

      // Compute track shot at this time, already including follow → direct transition
      const t = opts.auto ? (videoEl.currentTime || m.timeSec) : m.timeSec;
      const targetShot = computeTrackShotAtTime(t);
      cameraFollowOffX = targetShot.offX || 0; // warm follow state
      animateShotTo(targetShot);
    } else {
      currentShotId = 'wide';
      updateCameraButtons('wide');
      animateShotTo(defaultShot);
    }
  }

  function checkAndApplyMarkers(currentTimeSec) {
    // If scrubbed backwards, unlock markers again
    if (currentTimeSec < prevTimeSec - 0.05) {
      markers.forEach(m => { m.hasTriggered = false; });
    }

    for (const m of markers) {
      if (m.hasTriggered) continue;
      if (currentTimeSec >= m.timeSec) {
        console.log('Auto-trigger marker:', m);
        applyMarker(m.id, { auto: true });
        m.hasTriggered = true;
      }
    }
  }

  // 16) UI bindings

  chkDots.addEventListener('change', () => {
    layerState.dots = chkDots.checked;
    applyLayerVisibility();
  });

  chkLabels.addEventListener('change', () => {
    layerState.labels = chkLabels.checked;
    applyLayerVisibility();
  });

  chkRect.addEventListener('change', () => {
    layerState.rect = chkRect.checked;
    applyLayerVisibility();
  });

  chkSpeed.addEventListener('change', () => {
    layerState.speed = chkSpeed.checked;
    applyLayerVisibility();
  });

  chkProjRect.addEventListener('change', () => {
    layerState.projRect = chkProjRect.checked;
    applyLayerVisibility();
  });

  chkSmooth.addEventListener('change', () => {
    smoothingEnabled = chkSmooth.checked;
    resetSmoothing();
  });

  btnCamWide.addEventListener('click', () => {
    currentShotId = 'wide';
    updateCameraButtons('wide');
    animateShotTo(defaultShot);
  });

  btnCamTrack.addEventListener('click', () => {
    currentShotId = 'track';
    updateCameraButtons('track');

    const t = videoEl.currentTime || 0;
    const targetShot = computeTrackShotAtTime(t);
    cameraFollowOffX = targetShot.offX || 0; // warm follow state
    animateShotTo(targetShot);
  });

  btnPlay.addEventListener('click', () => {
    if (videoEl.paused) {
      markers.forEach(m => { m.hasTriggered = false; });
      prevTimeSec = videoEl.currentTime || 0;
      videoEl.play().catch(() => {});
      btnPlay.textContent = 'Pause';
    } else {
      videoEl.pause();
      btnPlay.textContent = 'Play';
    }
  });

  btnAddMarker.addEventListener('click', () => {
    addMarkerAtCurrentTime();
  });

  // 17) Start loop
  if (videoEl.readyState >= 1) {
    startOverlayLoop();
  } else {
    videoEl.addEventListener('loadedmetadata', () => {
      startOverlayLoop();
    }, { once: true });
  }

  updateCameraButtons('wide');
}

init();