// src/data/overlayLoader.js

export async function loadOverlay(url) {
  const res = await fetch(url);
  const data = await res.json();

  const fps = data.video?.fps || 30;
  const frames = data.frames || [];
  const athletes = data.athletes || [];

  // 建立快速 map
  const athletesById = new Map();
  athletes.forEach(a => athletesById.set(a.id, a));

  return {
    raw: data,
    fps,
    frames,
    athletes,
    athletesById,
    getFrameByIndex(i) {
      return frames[i] || null;
    },
    getFrameByTime(t) {
      // 基于时间查找最近一帧
      const index = Math.round(t * fps);
      return frames[index] || null;
    }
  };
}