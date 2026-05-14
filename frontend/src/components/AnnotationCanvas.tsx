import { Group, Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { BoundingBox, ProjectLabel } from "../types";

// ============================================================
// HOOK: Image Loader
// ============================================================
function useImageLoader(url: string) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { setImage(img); setLoading(false); };
    img.onerror = () => { setError("Failed to load image"); setLoading(false); };
    img.src = url;
  }, [url]);

  return { image, loading, error };
}

// ============================================================
// UTILS
// ============================================================
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ============================================================
// HOOK: Undo/Redo History
// ============================================================
function useHistory(initial: BoundingBox[]) {
  const [history, setHistory] = useState<BoundingBox[][]>([initial]);
  const [index, setIndex] = useState(0);

  // Sync with external changes (e.g. pre-annotations loaded)
  useEffect(() => {
    if (JSON.stringify(initial) !== JSON.stringify(history[index])) {
      setHistory([initial]);
      setIndex(0);
    }
  }, [initial]);

  const push = useCallback((boxes: BoundingBox[]) => {
    setHistory(prev => {
      const next = prev.slice(0, index + 1);
      next.push(boxes);
      if (next.length > 50) next.shift();
      return next;
    });
    setIndex(prev => Math.min(prev + 1, 49));
  }, [index]);

  const undo = useCallback(() => {
    if (index > 0) setIndex(prev => prev - 1);
  }, [index]);

  const redo = useCallback(() => {
    if (index < history.length - 1) setIndex(prev => prev + 1);
  }, [index, history.length]);

  return {
    boxes: history[index] || initial,
    push,
    undo,
    redo,
    canUndo: index > 0,
    canRedo: index < history.length - 1,
  };
}

// ============================================================
// HOOK: Annotation Hotkeys
// ============================================================
function useAnnotationHotkeys({
  selectedBoxIndex, boxes, labels, history, copiedBox,
  onDelete, onEscape, onToolChange, onUndo, onRedo,
  onCopy, onPaste, onToggleHelp,
}: {
  selectedBoxIndex: number | null;
  boxes: BoundingBox[];
  labels: ProjectLabel[];
  history: { undo: () => void; redo: () => void };
  copiedBox: BoundingBox | null;
  onDelete: () => void;
  onEscape: () => void;
  onToolChange: (tool: "draw" | "pan") => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onToggleHelp: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // Delete
      if ((e.key === "Delete" || e.key === "Backspace") && selectedBoxIndex !== null) {
        e.preventDefault();
        onDelete();
        return;
      }

      // Escape
      if (e.key === "Escape") { onEscape(); return; }

      // Tools
      if (e.key === "d" || e.key === "D") { onToolChange("draw"); return; }
      if (e.key === "p" || e.key === "P") { onToolChange("pan"); return; }

      // Quick label (1-9)
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        const idx = parseInt(e.key) - 1;
        if (idx < labels.length) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("annotation:select-label", { detail: labels[idx].name }));
        }
        return;
      }

      // Undo (Ctrl+Z)
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        onUndo();
        return;
      }

      // Redo (Ctrl+Shift+Z)
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        onRedo();
        return;
      }

      // Copy (Ctrl+C)
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && selectedBoxIndex !== null) {
        e.preventDefault();
        onCopy();
        return;
      }

      // Paste (Ctrl+V)
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && copiedBox) {
        e.preventDefault();
        onPaste();
        return;
      }

      // Help
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        onToggleHelp();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedBoxIndex, labels, copiedBox]);
}

// ============================================================
// COMPONENT: Hotkeys Modal
// ============================================================
function HotkeysHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { keys: "1-9", desc: "Выбрать метку по номеру" },
    { keys: "Delete / Backspace", desc: "Удалить выбранную рамку" },
    { keys: "Ctrl+Z", desc: "Отменить (Undo)" },
    { keys: "Ctrl+Shift+Z", desc: "Повторить (Redo)" },
    { keys: "Ctrl+C", desc: "Копировать рамку" },
    { keys: "Ctrl+V", desc: "Вставить рамку" },
    { keys: "Escape", desc: "Снять выделение" },
    { keys: "D", desc: "Инструмент «Разметка»" },
    { keys: "P", desc: "Инструмент «Перемещение»" },
    { keys: "Ctrl+S", desc: "Сохранить черновик" },
    { keys: "Enter", desc: "Отправить разметку" },
    { keys: "→ / ←", desc: "Навигация по кадрам" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-md overflow-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">⌨️ Горячие клавиши</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>
        <div className="space-y-2">
          {shortcuts.map(s => (
            <div key={s.keys} className="flex justify-between text-sm">
              <span className="font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">{s.keys}</span>
              <span className="text-gray-600 dark:text-gray-400">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// COMPONENT: Toolbar (CVAT-style grouped buttons)
// ============================================================
function Toolbar({
  tool, onToolChange, canUndo, canRedo, onUndo, onRedo,
  zoom, onZoom, onResetView, onToggleHelp,
}: {
  tool: "draw" | "pan";
  onToolChange: (t: "draw" | "pan") => void;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void;
  zoom: number;
  onZoom: (delta: number) => void;
  onResetView: () => void;
  onToggleHelp: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-800 dark:bg-gray-950">
      {/* Tools group */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`btn-secondary ${tool === "draw" ? "ring-2 ring-blue-400" : ""}`}
          onClick={() => onToolChange("draw")}
        >
          ✏️ Разметка <span className="text-xs opacity-50 ml-1">D</span>
        </button>
        <button
          type="button"
          className={`btn-secondary ${tool === "pan" ? "ring-2 ring-blue-400" : ""}`}
          onClick={() => onToolChange("pan")}
        >
          ✋ Перемещение <span className="text-xs opacity-50 ml-1">P</span>
        </button>
      </div>

      {/* Actions group */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-300 dark:text-gray-700">|</span>
        <button type="button" className="btn-secondary text-xs" disabled={!canUndo} onClick={onUndo}>
          ↩ Отменить <span className="text-xs opacity-50 ml-1">Ctrl+Z</span>
        </button>
        <button type="button" className="btn-secondary text-xs" disabled={!canRedo} onClick={onRedo}>
          ↪ Повторить <span className="text-xs opacity-50 ml-1">Ctrl+Shift+Z</span>
        </button>
      </div>

      {/* Zoom group */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-300 dark:text-gray-700">|</span>
        <button type="button" className="btn-secondary text-xs" onClick={() => onZoom(-0.2)}>−</button>
        <span className="min-w-[60px] text-center text-xs font-medium text-gray-600 dark:text-gray-300">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn-secondary text-xs" onClick={() => onZoom(+0.2)}>+</button>
        <button type="button" className="btn-secondary text-xs" onClick={onResetView}>Сброс</button>
        <span className="text-gray-300 dark:text-gray-700">|</span>
        <button type="button" className="btn-secondary text-xs font-bold" onClick={onToggleHelp} title="Горячие клавиши">?</button>
      </div>
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function AnnotationCanvas({
  imageUrl, value, labels, currentLabel,
  selectedBoxIndex, onSelectedBoxIndexChange, onBoxesChange,
}: {
  imageUrl: string;
  value: BoundingBox[];
  labels: ProjectLabel[];
  currentLabel: string;
  selectedBoxIndex: number | null;
  onSelectedBoxIndexChange: (index: number | null) => void;
  onBoxesChange: (boxes: BoundingBox[]) => void;
}) {
  // Refs
  const stageRef = useRef<any>(null);
  const contentRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // State
  const [drawing, setDrawing] = useState(false);
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<"draw" | "pan">("draw");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportWidth, setViewportWidth] = useState(1100);
  const [viewportHeight, setViewportHeight] = useState(760);
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [copiedBox, setCopiedBox] = useState<BoundingBox | null>(null);

  // History
  const history = useHistory(value);
  useEffect(() => { onBoxesChange(history.boxes); }, [history.boxes]);

  // Image
  const { image, loading, error } = useImageLoader(imageUrl);
  const imageWidth = image?.width || 1;
  const imageHeight = image?.height || 1;

  // Viewport resize
  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      const w = containerRef.current?.clientWidth || 1100;
      const h = typeof window !== "undefined" ? Math.max(520, window.innerHeight - 240) : 760;
      setViewportWidth(w);
      setViewportHeight(Math.min(760, h));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Canvas sizing
  const { canvasWidth, canvasHeight, fitScale, stageWidth, stageHeight, imageOffset } = useMemo(() => {
    if (!image) return { canvasWidth: viewportWidth, canvasHeight: 640, fitScale: 1, stageWidth: viewportWidth, stageHeight: 640, imageOffset: { x: 0, y: 0 } };
    const ratio = Math.min(viewportWidth / image.width, viewportHeight / image.height, 1);
    const cw = image.width * ratio, ch = image.height * ratio;
    const sw = Math.max(viewportWidth, cw), sh = Math.max(viewportHeight, ch);
    return {
      canvasWidth: cw, canvasHeight: ch, fitScale: ratio,
      stageWidth: sw, stageHeight: sh,
      imageOffset: { x: Math.max(0, (sw - cw) / 2), y: Math.max(0, (sh - ch) / 2) },
    };
  }, [image, viewportHeight, viewportWidth]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: imageOffset.x, y: imageOffset.y });
  }, [imageUrl, canvasWidth, canvasHeight]);

  const labelColorMap = useMemo(() => new Map(labels.map(l => [l.name, l.color || "#ef4444"])), [labels]);

  // Coordinates
  const toImageCoords = (x: number, y: number) => ({ x: clamp(x / fitScale, 0, imageWidth), y: clamp(y / fitScale, 0, imageHeight) });
  const toCanvasCoords = (box: BoundingBox) => ({ x: box.x * fitScale, y: box.y * fitScale, width: box.width * fitScale, height: box.height * fitScale });
  const getPointer = () => { const p = contentRef.current?.getRelativePointerPosition(); return p ? { x: clamp(p.x, 0, canvasWidth), y: clamp(p.y, 0, canvasHeight) } : null; };

  // Mouse
  const handleMouseDown = (e: any) => {
    if (tool === "pan") return;
    if (e.target?.className && e.target.className !== "Stage" && e.target.className !== "Image") return;
    if (!currentLabel) return;
    const pos = getPointer(); if (!pos) return;
    setDrawing(true); setStartPos(pos); setCurrentPos(pos);
    onSelectedBoxIndexChange(null);
  };
  const handleMouseMove = () => { if (!drawing) return; const pos = getPointer(); if (pos) setCurrentPos(pos); };
  const handleMouseUp = () => {
    if (!drawing || !startPos || !currentPos || !currentLabel) { setDrawing(false); setStartPos(null); setCurrentPos(null); return; }
    const s = toImageCoords(startPos.x, startPos.y), e = toImageCoords(currentPos.x, currentPos.y);
    const box: BoundingBox = { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), width: Math.abs(e.x - s.x), height: Math.abs(e.y - s.y), label: currentLabel };
    if (box.width > 4 && box.height > 4) {
      const newBoxes = [...value, box];
      history.push(newBoxes);
      onBoxesChange(newBoxes);
      onSelectedBoxIndexChange(newBoxes.length - 1);
    }
    setDrawing(false); setStartPos(null); setCurrentPos(null);
  };

  // Drag
  const updateDraggedBox = (index: number, nx: number, ny: number) => {
    const newBoxes = value.map((box, i) => i === index ? { ...box, x: clamp(nx / fitScale, 0, Math.max(0, imageWidth - box.width)), y: clamp(ny / fitScale, 0, Math.max(0, imageHeight - box.height)) } : box);
    history.push(newBoxes);
    onBoxesChange(newBoxes);
  };

  // Zoom
  const applyZoom = (next: number) => {
    const clamped = clamp(next, 1, 5);
    const ptr = stageRef.current?.getPointerPosition();
    if (!ptr) { setZoom(clamped); return; }
    const mx = (ptr.x - pan.x) / zoom, my = (ptr.y - pan.y) / zoom;
    setZoom(clamped);
    setPan({ x: ptr.x - mx * clamped, y: ptr.y - my * clamped });
  };

  // Hotkeys
  useAnnotationHotkeys({
    selectedBoxIndex, boxes: value, labels, history, copiedBox,
    onDelete: () => {
      if (selectedBoxIndex === null) return;
      const newBoxes = value.filter((_, i) => i !== selectedBoxIndex);
      history.push(newBoxes);
      onBoxesChange(newBoxes);
      onSelectedBoxIndexChange(null);
    },
    onEscape: () => onSelectedBoxIndexChange(null),
    onToolChange: setTool,
    onUndo: () => { history.undo(); onSelectedBoxIndexChange(null); },
    onRedo: () => { history.redo(); onSelectedBoxIndexChange(null); },
    onCopy: () => { if (selectedBoxIndex !== null) setCopiedBox({ ...value[selectedBoxIndex] }); },
    onPaste: () => {
      if (!copiedBox) return;
      const box = { ...copiedBox, x: copiedBox.x + 10, y: copiedBox.y + 10 };
      const newBoxes = [...value, box];
      history.push(newBoxes);
      onBoxesChange(newBoxes);
      onSelectedBoxIndexChange(newBoxes.length - 1);
    },
    onToggleHelp: () => setShowHotkeys(prev => !prev),
  });

  // Render
  if (loading) return <div className="flex h-[560px] items-center justify-center rounded-lg bg-gray-100 text-sm text-gray-500">Загрузка...</div>;
  if (error || !imageUrl) return <div className="flex h-[560px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500">{error || "Кадр недоступен"}</div>;

  return (
    <div className="space-y-3">
      <Toolbar
        tool={tool} onToolChange={setTool}
        canUndo={history.canUndo} canRedo={history.canRedo}
        onUndo={() => { history.undo(); onSelectedBoxIndexChange(null); }}
        onRedo={() => { history.redo(); onSelectedBoxIndexChange(null); }}
        zoom={zoom} onZoom={(d) => applyZoom(zoom + d)}
        onResetView={() => { setZoom(1); setPan({ x: imageOffset.x, y: imageOffset.y }); }}
        onToggleHelp={() => setShowHotkeys(true)}
      />

      <div ref={containerRef} className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-950">
        <Stage ref={stageRef} width={stageWidth} height={stageHeight}
          onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
          onWheel={(e) => { e.evt.preventDefault(); applyZoom(zoom + (e.evt.deltaY > 0 ? -0.15 : 0.15)); }}
          className={tool === "pan" ? "cursor-grab" : "cursor-crosshair"}
        >
          <Layer>
            <Group ref={contentRef} x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom}
              draggable={tool === "pan"}
              onDragEnd={(e) => setPan({ x: e.target.x(), y: e.target.y() })}
            >
              {image && <KonvaImage image={image} width={canvasWidth} height={canvasHeight} />}
              {value.map((box, i) => {
                const cb = toCanvasCoords(box);
                const color = labelColorMap.get(box.label) || "#ef4444";
                const sel = selectedBoxIndex === i;
                return (
                  <Group key={`${box.label}-${i}`} draggable={tool === "draw"}
                    onClick={(e) => { e.cancelBubble = true; onSelectedBoxIndexChange(i); }}
                    onTap={(e) => { e.cancelBubble = true; onSelectedBoxIndexChange(i); }}
                    onDragEnd={(e) => updateDraggedBox(i, e.target.x(), e.target.y())}
                    x={cb.x} y={cb.y}
                  >
                    <Rect width={cb.width} height={cb.height} stroke={color} strokeWidth={sel ? 3 : 2} dash={sel ? [8, 4] : undefined} />
                    <Text y={-18} text={box.label} fill={color} fontSize={14} fontStyle="bold" />
                  </Group>
                );
              })}
              {drawing && startPos && currentPos && (
                <Rect x={Math.min(startPos.x, currentPos.x)} y={Math.min(startPos.y, currentPos.y)}
                  width={Math.abs(currentPos.x - startPos.x)} height={Math.abs(currentPos.y - startPos.y)}
                  stroke="#2563eb" strokeWidth={2} dash={[8, 4]} />
              )}
            </Group>
          </Layer>
        </Stage>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-500 dark:text-gray-400">
        <span>🖱️ {tool === "draw" ? "Разметка" : "Перемещение"} | Метка: <b>{currentLabel || "не выбрана"}</b></span>
        <span>{value.length} рамок</span>
      </div>

      {showHotkeys && <HotkeysHelp onClose={() => setShowHotkeys(false)} />}
    </div>
  );
}
