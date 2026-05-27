import {
  Group,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
} from "react-konva";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { BoundingBox, ProjectLabel } from "../types";

function useImageLoader(url: string) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      setImage(img);
      setLoading(false);
    };
    img.onerror = () => {
      setError("Failed to load image");
      setLoading(false);
    };
    img.src = url;
  }, [url]);

  return { image, loading, error };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ============================================================
// HOTKEYS HELP MODAL
// ============================================================
function HotkeysHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { keys: "1-9", desc: "Выбрать метку по номеру" },
    { keys: "Delete / Backspace", desc: "Удалить выбранную рамку" },
    { keys: "Ctrl+Z", desc: "Отменить последнее действие" },
    { keys: "Ctrl+Shift+Z", desc: "Повторить отменённое" },
    { keys: "Ctrl+C", desc: "Копировать выбранную рамку" },
    { keys: "Ctrl+V", desc: "Вставить скопированную рамку" },
    { keys: "Escape", desc: "Снять выделение с рамки" },
    { keys: "D", desc: "Инструмент «Разметка»" },
    { keys: "P", desc: "Инструмент «Перемещение»" },
    { keys: "Ctrl+S", desc: "Сохранить черновик" },
    { keys: "Enter", desc: "Отправить финальную разметку" },
    { keys: "→ / ←", desc: "Следующий / предыдущий кадр" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-md overflow-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            ⌨️ Горячие клавиши
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((s) => (
            <div key={s.keys} className="flex justify-between text-sm">
              <span className="font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                {s.keys}
              </span>
              <span className="text-gray-600 dark:text-gray-400">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function AnnotationCanvas({
  imageUrl,
  value,
  labels,
  currentLabel,
  selectedBoxIndex,
  onSelectedBoxIndexChange,
  onBoxesChange,
}: {
  imageUrl: string;
  value: BoundingBox[];
  labels: ProjectLabel[];
  currentLabel: string;
  selectedBoxIndex: number | null;
  onSelectedBoxIndexChange: (index: number | null) => void;
  onBoxesChange: (boxes: BoundingBox[]) => void;
}) {
  const stageRef = useRef<any>(null);
  const contentRef = useRef<any>(null);
  const deviceWidth = window.innerWidth
  const deviceHeight = window.innerHeight
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [tool, setTool] = useState<"draw" | "pan">("draw");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
    const [viewportWidth, setViewportWidth] = useState(deviceWidth);
  const [viewportHeight, setViewportHeight] = useState(deviceHeight);
  const [showHotkeys, setShowHotkeys] = useState(false);

  // Undo/Redo
  const [history, setHistory] = useState<BoundingBox[][]>([value]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [copiedBox, setCopiedBox] = useState<BoundingBox | null>(null);

  const { image, loading, error } = useImageLoader(imageUrl);

  const imageWidth = image?.width || 1;
  const imageHeight = image?.height || 1;

  // ---- Sync external value changes into history ----
  useEffect(() => {
    // When value changes from outside (e.g. pre-annotations loaded), reset history
    if (JSON.stringify(value) !== JSON.stringify(history[historyIndex])) {
      setHistory([value]);
      setHistoryIndex(0);
    }
  }, [value]);

  // ---- Push to history helper ----
  const pushHistory = useCallback(
    (newBoxes: BoundingBox[]) => {
      const next = history.slice(0, historyIndex + 1);
      next.push(newBoxes);
      // Keep max 50 entries
      if (next.length > 50) next.shift();
      setHistory(next);
      setHistoryIndex(next.length - 1);
    },
    [history, historyIndex],
  );

  // ---- Viewport resize ----
  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      const width =
        typeof window !== "undefined"
          ? window.innerWidth
          : containerRef.current?.clientWidth || 1100;
      const height =
        typeof window !== "undefined"
          ? window.innerHeight - 56
          : containerRef.current?.clientHeight || 760;
      setViewportWidth(width);
      setViewportHeight(Math.max(560, height));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  // ---- Canvas sizing ----
  const { canvasWidth, canvasHeight, fitScale, stageWidth, stageHeight } =
    useMemo(() => {
      if (!image) {
        const fallbackHeight = Math.min(640, viewportHeight);
        return {
          canvasWidth: viewportWidth,
          canvasHeight: fallbackHeight,
          fitScale: 1,
          stageWidth: viewportWidth,
          stageHeight: fallbackHeight,
        };
      }
      const ratio = Math.min(
        viewportWidth / image.width,
        viewportHeight / image.height,
      );
      const nextCanvasWidth = image.width * ratio;
      const nextCanvasHeight = image.height * ratio;
      return {
        canvasWidth: nextCanvasWidth,
        canvasHeight: nextCanvasHeight,
        fitScale: ratio,
        stageWidth: viewportWidth,
        stageHeight: viewportHeight,
      };
    }, [image, viewportHeight, viewportWidth]);

  const backdrop = useMemo(() => {
    if (!image) {
      return { x: 0, y: 0, width: stageWidth, height: stageHeight };
    }
    const ratio = Math.max(
      stageWidth / image.width,
      stageHeight / image.height,
    );
    const width = image.width * ratio;
    const height = image.height * ratio;
    return {
      x: (stageWidth - width) / 2,
      y: (stageHeight - height) / 2,
      width,
      height,
    };
  }, [image, stageHeight, stageWidth]);

  const clampPan = useCallback(
    (nextPan: { x: number; y: number }, nextZoom: number) => {
      const scaledWidth = canvasWidth * nextZoom;
      const scaledHeight = canvasHeight * nextZoom;
      const x =
        scaledWidth <= stageWidth
          ? (stageWidth - scaledWidth) / 2
          : clamp(nextPan.x, stageWidth - scaledWidth, 0);
      const y =
        scaledHeight <= stageHeight
          ? (stageHeight - scaledHeight) / 2
          : clamp(nextPan.y, stageHeight - scaledHeight, 0);
      return { x, y };
    },
    [canvasHeight, canvasWidth, stageHeight, stageWidth],
  );

  const getCenteredPan = useCallback(
    (nextZoom: number) => ({
      x: (stageWidth - canvasWidth * nextZoom) / 2,
      y: (stageHeight - canvasHeight * nextZoom) / 2,
    }),
    [canvasHeight, canvasWidth, stageHeight, stageWidth],
  );

  useEffect(() => {
    setZoom(1);
    setPan(clampPan(getCenteredPan(1), 1));
  }, [imageUrl, canvasWidth, canvasHeight, clampPan, getCenteredPan]);

  const labelColorMap = useMemo(() => {
    return new Map(
      labels.map((label) => [label.name, label.color || "#ef4444"]),
    );
  }, [labels]);

  // ---- Coordinate transforms ----
  const toImageCoords = (x: number, y: number) => ({
    x: clamp(x / fitScale, 0, imageWidth),
    y: clamp(y / fitScale, 0, imageHeight),
  });

  const toCanvasCoords = (box: BoundingBox) => ({
    x: box.x * fitScale,
    y: box.y * fitScale,
    width: box.width * fitScale,
    height: box.height * fitScale,
  });

  const getPointerOnCanvas = () => {
    const position = contentRef.current?.getRelativePointerPosition();
    if (!position) return null;
    return {
      x: clamp(position.x, 0, canvasWidth),
      y: clamp(position.y, 0, canvasHeight),
    };
  };

  // ---- Mouse handlers ----
  const handleMouseDown = (event: any) => {
    if (tool === "pan") return;
    const targetClassName = event.target?.className;
    if (targetClassName !== "Image") return;
    if (!currentLabel) return;
    const pos = getPointerOnCanvas();
    if (!pos) return;
    setDrawing(true);
    setStartPos(pos);
    setCurrentPos(pos);
    onSelectedBoxIndexChange(null);
  };

  const handleMouseMove = () => {
    if (!drawing) return;
    const pos = getPointerOnCanvas();
    if (!pos) return;
    setCurrentPos(pos);
  };

  const handleMouseUp = () => {
    if (!drawing || !startPos || !currentPos || !currentLabel) {
      setDrawing(false);
      setStartPos(null);
      setCurrentPos(null);
      return;
    }

    const start = toImageCoords(startPos.x, startPos.y);
    const end = toImageCoords(currentPos.x, currentPos.y);
    const nextBox: BoundingBox = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      label: currentLabel,
    };

    if (nextBox.width > 4 && nextBox.height > 4) {
      const newBoxes = [...value, nextBox];
      pushHistory(newBoxes);
      onBoxesChange(newBoxes);
      onSelectedBoxIndexChange(newBoxes.length - 1); // ✅ исправлено: теперь показывает правильный индекс
    }

    setDrawing(false);
    setStartPos(null);
    setCurrentPos(null);
  };

  // ---- Drag / Update ----
  const updateDraggedBox = (index: number, nextX: number, nextY: number) => {
    const newBoxes = value.map((box, boxIndex) =>
      boxIndex === index
        ? {
            ...box,
            x: clamp(nextX / fitScale, 0, Math.max(0, imageWidth - box.width)),
            y: clamp(
              nextY / fitScale,
              0,
              Math.max(0, imageHeight - box.height),
            ),
          }
        : box,
    );
    pushHistory(newBoxes);
    onBoxesChange(newBoxes);
  };

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      onBoxesChange(history[newIndex]);
      onSelectedBoxIndexChange(null);
    }
  }, [history, historyIndex, onBoxesChange, onSelectedBoxIndexChange]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      onBoxesChange(history[newIndex]);
      onSelectedBoxIndexChange(null);
    }
  }, [history, historyIndex, onBoxesChange, onSelectedBoxIndexChange]);

  // ---- Zoom ----
  const resetView = () => {
    setZoom(1);
    setPan(clampPan(getCenteredPan(1), 1));
  };

  const applyZoom = (nextZoom: number) => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    const clampedZoom = clamp(nextZoom, 1, 5);
    if (!pointer) {
      setZoom(clampedZoom);
      setPan((current) => clampPan(current, clampedZoom));
      return;
    }
    const mousePointTo = {
      x: (pointer.x - pan.x) / zoom,
      y: (pointer.y - pan.y) / zoom,
    };
    setZoom(clampedZoom);
    setPan(
      clampPan(
        {
          x: pointer.x - mousePointTo.x * clampedZoom,
          y: pointer.y - mousePointTo.y * clampedZoom,
        },
        clampedZoom,
      ),
    );
  };

  const handleWheel = (event: any) => {
    event.evt.preventDefault();
    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const nextZoom = zoom + direction * 0.15;
    applyZoom(nextZoom);
  };

  // ============================================================
  // ⌨️ HOTKEYS
  // ============================================================
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // ---- Delete selected box ----
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedBoxIndex !== null
      ) {
        e.preventDefault();
        const newBoxes = value.filter((_, i) => i !== selectedBoxIndex);
        pushHistory(newBoxes);
        onBoxesChange(newBoxes);
        onSelectedBoxIndexChange(null);
        return;
      }

      // ---- Escape ----
      if (e.key === "Escape") {
        onSelectedBoxIndexChange(null);
        return;
      }

      // ---- Tool switch ----
      if (e.key === "d" || e.key === "D") {
        setTool("draw");
        return;
      }
      if (e.key === "p" || e.key === "P") {
        setTool("pan");
        return;
      }

      // ---- Quick label select (1-9) ----
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        const idx = parseInt(e.key) - 1;
        if (idx < labels.length) {
          e.preventDefault();
          // We need to call onLabelSelect — pass via a custom event or prop
          // For now we dispatch a custom event that AnnotationPage listens to
          window.dispatchEvent(
            new CustomEvent("annotation:select-label", {
              detail: labels[idx].name,
            }),
          );
        }
        return;
      }

      // ---- Undo (Ctrl+Z) ----
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // ---- Redo (Ctrl+Shift+Z) ----
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }

      // ---- Copy (Ctrl+C) ----
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "c" &&
        selectedBoxIndex !== null
      ) {
        e.preventDefault();
        setCopiedBox({ ...value[selectedBoxIndex] });
        return;
      }

      // ---- Paste (Ctrl+V) ----
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && copiedBox) {
        e.preventDefault();
        const newBox = {
          ...copiedBox,
          x: copiedBox.x + 10,
          y: copiedBox.y + 10,
        };
        const newBoxes = [...value, newBox];
        pushHistory(newBoxes);
        onBoxesChange(newBoxes);
        onSelectedBoxIndexChange(newBoxes.length - 1);
        return;
      }

      // ---- Hotkeys help ----
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        setShowHotkeys((prev) => !prev);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    selectedBoxIndex,
    value,
    labels,
    history,
    historyIndex,
    copiedBox,
    tool,
    fitScale,
    imageWidth,
    imageHeight,
    undo,
    redo,
  ]);

  useEffect(() => {
    window.addEventListener("annotation:undo", undo);
    window.addEventListener("annotation:redo", redo);
    const setDrawTool = () => setTool("draw");
    const setPanTool = () => setTool("pan");
    const zoomIn = () => applyZoom(zoom + 0.2);
    const zoomOut = () => applyZoom(zoom - 0.2);
    window.addEventListener("annotation:tool-draw", setDrawTool);
    window.addEventListener("annotation:tool-pan", setPanTool);
    window.addEventListener("annotation:zoom-in", zoomIn);
    window.addEventListener("annotation:zoom-out", zoomOut);
    window.addEventListener("annotation:reset-view", resetView);
    return () => {
      window.removeEventListener("annotation:undo", undo);
      window.removeEventListener("annotation:redo", redo);
      window.removeEventListener("annotation:tool-draw", setDrawTool);
      window.removeEventListener("annotation:tool-pan", setPanTool);
      window.removeEventListener("annotation:zoom-in", zoomIn);
      window.removeEventListener("annotation:zoom-out", zoomOut);
      window.removeEventListener("annotation:reset-view", resetView);
    };
  }, [undo, redo, zoom]);

  // ---- Loading / Error states ----
  if (loading) {
    return (
      <div className="flex h-[560px] items-center justify-center rounded-lg bg-gray-100 text-sm text-gray-500">
        Загрузка изображения...
      </div>
    );
  }

  if (error || !imageUrl) {
    return (
      <div className="flex h-[560px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500">
        {error || "Кадр недоступен"}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0">
      <div className="relative h-full min-h-0">
        <div
          ref={containerRef}
          className="h-full min-h-0 overflow-hidden bg-gray-950"
        >
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={stageHeight}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            className={tool === "pan" ? "cursor-grab" : "cursor-crosshair"}
          >
            <Layer>
              {image ? (
                <KonvaImage
                  image={image}
                  x={backdrop.x}
                  y={backdrop.y}
                  width={backdrop.width}
                  height={backdrop.height}
                  opacity={0.22}
                  listening={false}
                />
              ) : null}
              <Rect
                width={stageWidth}
                height={stageHeight}
                fill="rgba(0,0,0,0.28)"
                listening={false}
              />
              <Group
                ref={contentRef}
                x={pan.x}
                y={pan.y}
                scaleX={zoom}
                scaleY={zoom}
                draggable={tool === "pan"}
                dragBoundFunc={(position) => clampPan(position, zoom)}
                onDragEnd={(event) =>
                  setPan(
                    clampPan(
                      { x: event.target.x(), y: event.target.y() },
                      zoom,
                    ),
                  )
                }
              >
                {image ? (
                  <KonvaImage
                    image={image}
                    width={canvasWidth}
                    height={canvasHeight}
                  />
                ) : null}
                {value.map((box, index) => {
                  const canvasBox = toCanvasCoords(box);
                  const color = labelColorMap.get(box.label) || "#ef4444";
                  const isSelected = selectedBoxIndex === index;
                  return (
                    <Group
                      key={`${box.label}-${index}`}
                      draggable={tool === "draw"}
                      onClick={(event) => {
                        event.cancelBubble = true;
                        onSelectedBoxIndexChange(index);
                      }}
                      onTap={(event) => {
                        event.cancelBubble = true;
                        onSelectedBoxIndexChange(index);
                      }}
                      onDragEnd={(event) =>
                        updateDraggedBox(
                          index,
                          event.target.x(),
                          event.target.y(),
                        )
                      }
                      x={canvasBox.x}
                      y={canvasBox.y}
                    >
                      <Rect
                        width={canvasBox.width}
                        height={canvasBox.height}
                        stroke={color}
                        strokeWidth={1}
                        dash={isSelected ? [8, 4] : undefined}
                      />
                      <Text
                        y={-18}
                        text={box.label}
                        fill={color}
                        fontSize={14}
                        fontStyle="bold"
                      />
                    </Group>
                  );
                })}
                {drawing && startPos && currentPos ? (
                  <Rect
                    x={Math.min(startPos.x, currentPos.x)}
                    y={Math.min(startPos.y, currentPos.y)}
                    width={Math.abs(currentPos.x - startPos.x)}
                    height={Math.abs(currentPos.y - startPos.y)}
                    stroke="#2563eb"
                    strokeWidth={1}
                    dash={[8, 4]}
                  />
                ) : null}
              </Group>
            </Layer>
          </Stage>
        </div>

        {/* ===== ⌨️ ? BUTTON — bottom-right corner ===== */}
        <button
          type="button"
          onClick={() => setShowHotkeys(true)}
          className="absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-gray-800/70 text-white shadow-lg hover:bg-gray-900/80 transition text-lg font-bold"
          title="Горячие клавиши"
        >
          ?
        </button>
      </div>

      {/* ===== HOTKEYS MODAL ===== */}
      {showHotkeys && <HotkeysHelp onClose={() => setShowHotkeys(false)} />}
    </div>
  );
}
