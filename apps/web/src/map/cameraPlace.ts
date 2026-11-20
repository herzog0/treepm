import { useEffect, useRef } from "react";
import type { SpatialBounds } from "@treepm/engine";
import type { TicketCloseCamera } from "../preferences/model.js";

/** "Lugar de antes" (ADR 0028): ponto do mundo no meio do palco, escala e a área do mundo que estava visível. */
export interface CameraPlace {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

interface CameraView {
  camera: { x: number; y: number; scale: number };
  size: { width: number; height: number };
}

export function capturePlace({ x, y, scale }: CameraView["camera"], size: CameraView["size"]): CameraPlace {
  return { x: (size.width / 2 - x) / scale, y: (size.height / 2 - y) / scale, scale, width: size.width / scale, height: size.height / scale };
}

/**
 * Argumentos de `fitBounds` sem nó alvo: limites centrados no lugar guardado e do tamanho da área que estava
 * visível. O ajuste (`fitScale`) fica sempre abaixo da escala guardada, que então vence em `max(fitScale, requiredScale)`.
 */
export function placeTarget(place: CameraPlace): { bounds: SpatialBounds; requiredScale: number } {
  return {
    bounds: { minX: place.x - place.width / 2, maxX: place.x + place.width / 2, minY: place.y - place.height / 2, maxY: place.y + place.height / 2 },
    requiredScale: place.scale,
  };
}

interface RestoreOptions {
  pageOpen: boolean;
  mode: TicketCloseCamera;
  getView: () => CameraView;
  restore: (target: ReturnType<typeof placeTarget>) => void;
}

/**
 * Guarda o lugar da câmera quando a página passa de fechada a aberta (uma vez; trocar de ticket com a página
 * aberta não regrava) e o restaura em qualquer fechamento, dois quadros depois, quando o palco já voltou à
 * largura inteira. Página aberta desde o início (pelo endereço) não tem lugar guardado.
 */
export function useRestoreCameraPlace(options: RestoreOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const previous = useRef(options.pageOpen);
  const place = useRef<CameraPlace | null>(null);

  useEffect(() => {
    const wasOpen = previous.current;
    previous.current = options.pageOpen;
    if (!wasOpen && options.pageOpen) {
      const { camera, size } = latest.current.getView();
      place.current = capturePlace(camera, size);
      return;
    }
    if (!(wasOpen && !options.pageOpen)) return;
    const stored = place.current;
    place.current = null;
    if (!stored || latest.current.mode !== "restore") return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => latest.current.restore(placeTarget(stored)));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [options.pageOpen]);
}
