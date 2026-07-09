let canvas;
let map;

export function initOverlay(canvasId = 'simulationCanvas', mapInstance) {
  canvas = document.getElementById(canvasId);
  map = mapInstance;
  if (!canvas || !map) return;
  map.on('move zoom moveend zoomend', resizeCanvas);
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas || !map) return;
  const size = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(size.x * dpr) || canvas.height !== Math.round(size.y * dpr)) {
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
  }
}

export function clearOverlay() {
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
