import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from "remotion";
import type { BlockOverlay } from "./schema";

/**
 * Bloques de HyperFrames dentro de Remotion. El backend sirve el HTML del bloque con los cambios aplicados y un
 * runtime que, al recibir {hfSeek: segundos}, lleva sus líneas de tiempo GSAP a ese instante y contesta {hfSeeked}.
 * El iframe va aislado (sandbox sin same-origin): el bloque no puede tocar el dashboard. Al renderizar, cada
 * fotograma espera a la respuesta (delayRender), así que el resultado es exacto aunque Remotion use varias pestañas.
 */

export function blockDocUrl(o: BlockOverlay, duration: number): string {
  const cfg = { vars: o.vars, texts: o.texts, colors: o.colors, images: o.images, transparent: o.transparent, duration: +duration.toFixed(3) };
  return `${o.src}?cfg=${encodeURIComponent(JSON.stringify(cfg))}`;
}

const cache = new Map<string, Promise<string>>();
function fetchDoc(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Bloque: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.text();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return p;
}

let seq = 0;

/** Un documento en su iframe. Avisa con onReady cuando ya muestra el primer instante pedido (o si no responde). */
const BlockFrame: React.FC<{ doc: string; width: number; height: number; scale: number; t: number; visible: boolean; onReady: () => void }> = ({
  doc, width, height, scale, t, visible, onReady,
}) => {
  const ref = useRef<HTMLIFrameElement>(null);
  const rendering = getRemotionEnvironment().isRendering;
  const [ready, setReady] = useState(false);
  const pending = useRef(new Map<number, number>());
  const first = useRef(true);
  const readyCb = useRef(onReady);
  readyCb.current = onReady;

  const done = (id: number) => {
    const h = pending.current.get(id);
    if (h !== undefined) {
      pending.current.delete(id);
      continueRender(h);
    }
    if (first.current) {
      first.current = false;
      readyCb.current();
    }
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const m = (e.data || {}) as { hfReady?: boolean; hfSeeked?: number };
      if (m.hfReady) setReady(true);
      if (typeof m.hfSeeked === "number") done(m.hfSeeked);
    };
    window.addEventListener("message", onMessage);
    const map = pending.current;
    return () => {
      window.removeEventListener("message", onMessage);
      map.forEach((h) => continueRender(h));
      map.clear();
    };
  }, []);

  useLayoutEffect(() => {
    if (!ready) return;
    const id = ++seq;
    if (rendering) pending.current.set(id, delayRender(`Bloque animado en ${t.toFixed(2)} s`, { timeoutInMilliseconds: 30000 }));
    ref.current?.contentWindow?.postMessage({ hfSeek: t, id }, "*");
    // Si el bloque se cuelga, el render sigue sin él en vez de fallar entero.
    const timer = window.setTimeout(() => done(id), rendering ? 8000 : 1500);
    return () => window.clearTimeout(timer);
  }, [t, ready, rendering]);

  return (
    <iframe
      ref={ref}
      title="Bloque animado"
      srcDoc={doc}
      sandbox="allow-scripts"
      // Si no contesta nunca (error del bloque), se da por cargado para no bloquear el render.
      onLoad={() => window.setTimeout(() => { if (first.current && !ready) { first.current = false; readyCb.current(); } }, 20000)}
      style={{
        position: "absolute", left: "50%", top: "50%", width, height, border: 0, background: "transparent",
        // Mismo esquema dentro y fuera: si no, Chrome pinta el iframe opaco en la interfaz oscura.
        colorScheme: "light", pointerEvents: "none", transform: `translate(-50%, -50%) scale(${scale})`,
        opacity: visible ? 1 : 0,
      }}
    />
  );
};

export const BlockView: React.FC<{ o: BlockOverlay; style?: React.CSSProperties }> = ({ o, style }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const rendering = getRemotionEnvironment().isRendering;
  const url = blockDocUrl(o, o.end - o.start);
  const [docs, setDocs] = useState<{ url: string; doc: string; ready: boolean }[]>([]);
  const [error, setError] = useState("");
  const handle = useRef<number | null>(null);

  const release = () => {
    if (handle.current !== null) {
      continueRender(handle.current);
      handle.current = null;
    }
  };

  useEffect(() => {
    let alive = true;
    if (rendering) {
      release();
      handle.current = delayRender(`Cargando el bloque ${o.block}`, { timeoutInMilliseconds: 90000 });
    }
    // En el editor se espera un poco a que dejes de escribir antes de recargar el bloque.
    const timer = window.setTimeout(() => {
      fetchDoc(url)
        .then((doc) => {
          if (!alive) return;
          setError("");
          setDocs((d) => [...d.filter((x) => x.ready).slice(-1), { url, doc, ready: false }]);
        })
        .catch((e: Error) => {
          if (rendering) cancelRender(e);
          else if (alive) setError(e.message);
        });
    }, rendering ? 0 : 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [url, rendering]);

  useEffect(() => release, []);

  const boxW = o.w * width;
  const boxH = o.h * height;
  const isComponent = !o.base_w || !o.base_h;
  const fw = isComponent ? boxW : o.base_w;
  const fh = isComponent ? boxH : o.base_h;
  const scale = isComponent ? 1 : Math.min(boxW / fw, boxH / fh);
  const shown = [...docs].reverse().find((d) => d.ready)?.url;

  return (
    <div style={{ position: "absolute", left: o.x * width - boxW / 2, top: o.y * height - boxH / 2, width: boxW, height: boxH, ...style }}>
      {docs.map((d) => (
        <BlockFrame key={d.url} doc={d.doc} width={fw} height={fh} scale={scale} t={frame / fps}
          visible={d.url === shown}
          onReady={() => {
            setDocs((list) => {
              const i = list.findIndex((x) => x.url === d.url);
              return i < 0 ? list : list.slice(i).map((x, k) => (k === 0 ? { ...x, ready: true } : x));
            });
            if (d.url === url) release();
          }} />
      ))}
      {error && !rendering && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(200,0,0,.35)",
          color: "#fff", font: `600 ${Math.round(height / 60)}px sans-serif`, textAlign: "center", padding: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
};
