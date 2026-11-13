/** «Más reproducido» de YouTube (backend pipeline/heatmap.py): tramos con un valor de 0 a 1. */
export type HeatPoint = { s: number; e: number; v: number };

/** Dibuja la curva como en la barra del reproductor de YouTube: zona rellena dentro de la franja [y, y + h].
 *  Se pinta antes que la forma de onda, para que quede detrás. */
export function drawHeat(ctx: CanvasRenderingContext2D, heat: HeatPoint[] | undefined, tx: (t: number) => number,
                         y: number, h: number, color: string) {
  if (!heat?.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tx(heat[0].s), y + h);
  for (const p of heat) ctx.lineTo(tx((p.s + p.e) / 2), y + h - p.v * h);
  ctx.lineTo(tx(heat[heat.length - 1].e), y + h);
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}
