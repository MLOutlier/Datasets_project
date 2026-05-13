import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";
import { VideoJsPlayer } from "../components/VideoJsPlayer";
import type { IntervalQueueItem, IntervalValidationQueueItem } from "../types";

type IntervalDraft = {
  start_frame: number;
  end_frame: number;
  confidence?: number;
  label?: string;
};

type DraftSnapshot = {
  intervals: IntervalDraft[];
  comment: string;
  intervalStartFrame: number | null;
};

function clampFrame(value: number, start: number, end: number) {
  return Math.min(Math.max(Math.round(value), start), end);
}

function frameToTime(frame: number, intervalSec: number) {
  return Math.max(0, frame * Math.max(intervalSec || 1, 0.1));
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return "0.0 с";
  return `${value.toFixed(1)} с`;
}

function frameDuration(item?: { start_frame?: number; end_frame?: number; duration_sec?: number }) {
  if (!item) return 0;
  const provided = Number(item.duration_sec);
  if (Number.isFinite(provided) && provided > 0) return provided;
  const start = Number(item.start_frame || 0);
  const end = Number(item.end_frame || 0);
  return Math.max(0, end - start);
}

function readDraft(key: string): DraftSnapshot | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftSnapshot>;
    return {
      intervals: Array.isArray(parsed.intervals) ? parsed.intervals : [],
      comment: String(parsed.comment || ""),
      intervalStartFrame: typeof parsed.intervalStartFrame === "number" ? parsed.intervalStartFrame : null,
    };
  } catch {
    return null;
  }
}

function writeDraft(key: string, payload: DraftSnapshot) {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function pickNextAssignmentId<T extends { assignment_id: string }>(items: T[], currentId: string | null) {
  if (!items.length) return null;
  const currentIndex = currentId ? items.findIndex((item) => item.assignment_id === currentId) : -1;
  const nextItem = currentIndex >= 0 ? items[currentIndex + 1] ?? items[0] : items[0];
  return nextItem?.assignment_id ?? null;
}

function TimelineStrip({
  startFrame,
  endFrame,
  currentFrame,
  intervals,
  draftStartFrame,
  onSeekFrame,
}: {
  startFrame: number;
  endFrame: number;
  currentFrame: number;
  intervals: IntervalDraft[];
  draftStartFrame: number | null;
  onSeekFrame: (frame: number) => void;
}) {
  const span = Math.max(1, endFrame - startFrame);

  const percentFor = (frame: number) => `${Math.min(100, Math.max(0, ((clampFrame(frame, startFrame, endFrame) - startFrame) / span) * 100))}%`;

  return (
    <button
      type="button"
      className="relative h-20 w-full overflow-hidden rounded-xl border border-gray-200 bg-gray-50 text-left dark:border-gray-800 dark:bg-gray-950"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        onSeekFrame(startFrame + Math.round(ratio * span));
      }}
    >
      <div className="absolute inset-x-3 top-8 h-3 rounded-full bg-gray-200 dark:bg-gray-800">
        {intervals.map((interval, index) => (
          <div
            key={`${interval.start_frame}-${interval.end_frame}-${index}`}
            className="absolute top-0 h-3 rounded-full bg-emerald-500/70"
            style={{
              left: percentFor(interval.start_frame),
              width: `calc(${percentFor(interval.end_frame)} - ${percentFor(interval.start_frame)})`,
              minWidth: "2px",
            }}
          />
        ))}
        {draftStartFrame !== null ? (
          <div className="absolute top-[-6px] h-5 w-[2px] bg-blue-500" style={{ left: percentFor(draftStartFrame) }} />
        ) : null}
        <div className="absolute top-[-6px] h-5 w-[2px] bg-red-500" style={{ left: percentFor(currentFrame) }} />
      </div>
      <div className="absolute inset-x-3 bottom-3 flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
        <span>{startFrame}</span>
        <span>{Math.round((startFrame + endFrame) / 2)}</span>
        <span>{endFrame}</span>
      </div>
      <div className="absolute left-3 top-3 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Таймлайн</div>
    </button>
  );
}

export default function VideoIntervalsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdFilter = searchParams.get("projectId") || "";
  const stageFilter = searchParams.get("stage") || "intervals";
  const isValidationMode = stageFilter === "interval-validation";

  const [selectedChunkAssignmentId, setSelectedChunkAssignmentId] = useState<string | null>(null);
  const [selectedIntervalValidationId, setSelectedIntervalValidationId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [intervalStartFrame, setIntervalStartFrame] = useState<number | null>(null);
  const [intervals, setIntervals] = useState<IntervalDraft[]>([]);
  const [history, setHistory] = useState<IntervalDraft[][]>([]);
  const [future, setFuture] = useState<IntervalDraft[][]>([]);
  const [playerState, setPlayerState] = useState({ currentTime: 0, duration: 0, paused: true, ended: false });
  const [statusNotice, setStatusNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const playerRef = useRef<any | null>(null);
  const intervalsRef = useRef<IntervalDraft[]>([]);

  const chunkQueueQuery = useQuery({
    queryKey: ["interval-chunk-queue"],
    queryFn: () => annotatorAPI.intervalChunkQueue(),
  });
  const intervalValidationQueueQuery = useQuery({
    queryKey: ["interval-validation-queue"],
    queryFn: () => annotatorAPI.intervalValidationQueue(),
  });

  const chunkItems = useMemo(
    () => ((chunkQueueQuery.data?.items ?? []) as IntervalQueueItem[]).filter((item) => !projectIdFilter || item.project_id === projectIdFilter),
    [chunkQueueQuery.data?.items, projectIdFilter]
  );
  const validationItems = useMemo(
    () => ((intervalValidationQueueQuery.data?.items ?? []) as IntervalValidationQueueItem[]).filter((item) => !projectIdFilter || item.project_id === projectIdFilter),
    [intervalValidationQueueQuery.data?.items, projectIdFilter]
  );

  const selectedChunk = useMemo(
    () => chunkItems.find((item) => item.assignment_id === selectedChunkAssignmentId) ?? chunkItems[0] ?? null,
    [chunkItems, selectedChunkAssignmentId]
  );
  const selectedValidation = useMemo(
    () => validationItems.find((item) => item.assignment_id === selectedIntervalValidationId) ?? validationItems[0] ?? null,
    [validationItems, selectedIntervalValidationId]
  );

  const activeItem = isValidationMode ? selectedValidation : selectedChunk;
  const activeAssignmentId = activeItem?.assignment_id ?? null;
  const activeDraftKey = activeAssignmentId ? `dataset_ai:video-interval:${isValidationMode ? "validation" : "annotation"}:${activeAssignmentId}` : null;
  const activeFrameInterval = Number(activeItem?.frame_interval_sec || 1);
  const activeStartFrame = Number(activeItem?.start_frame || 0);
  const activeEndFrame = Number(activeItem?.end_frame || activeStartFrame);
  const activeDurationSec = frameDuration(activeItem);
  const validationClipStartSec = isValidationMode && selectedValidation?.clip?.clip_uri ? Number(selectedValidation.clip.start_sec || 0) : 0;

  const mediaSrc = isValidationMode
    ? selectedValidation?.clip?.clip_uri || selectedValidation?.clip?.uri || selectedValidation?.asset_uri || ""
    : selectedChunk?.asset_uri || "";

  const currentFrame = useMemo(() => {
    if (!activeItem) return activeStartFrame;
    const absoluteTime = isValidationMode ? validationClipStartSec + playerState.currentTime : playerState.currentTime;
    return clampFrame(Math.round(absoluteTime / activeFrameInterval), activeStartFrame, activeEndFrame);
  }, [activeFrameInterval, activeEndFrame, activeItem, activeStartFrame, isValidationMode, playerState.currentTime, validationClipStartSec]);

  const totalTimeLabel = formatSeconds(activeDurationSec);
  const defaultLabel = selectedChunk?.label_schema?.[0]?.name || "interval";

  const commitIntervals = (next: IntervalDraft[]) => {
    setHistory((prev) => [...prev, intervalsRef.current]);
    setFuture([]);
    setIntervals(next);
  };

  const updateInterval = (index: number, patch: Partial<IntervalDraft>) => {
    commitIntervals(intervalsRef.current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };

  const removeInterval = (index: number) => {
    commitIntervals(intervalsRef.current.filter((_, itemIndex) => itemIndex !== index));
  };

  const undoIntervals = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((prev) => [intervalsRef.current, ...prev]);
    setHistory((prev) => prev.slice(0, -1));
    setIntervals(previous);
  };

  const redoIntervals = () => {
    const next = future[0];
    if (!next) return;
    setHistory((prev) => [...prev, intervalsRef.current]);
    setFuture((prev) => prev.slice(1));
    setIntervals(next);
  };

  const seekFrame = (frame: number) => {
    const player = playerRef.current;
    if (!player || !activeItem) return;
    const absoluteTime = frameToTime(frame, activeFrameInterval);
    const nextTime = isValidationMode && selectedValidation?.clip?.clip_uri ? Math.max(0, absoluteTime - validationClipStartSec) : absoluteTime;
    player.currentTime?.(nextTime);
  };

  const stepFrames = (delta: number) => {
    const player = playerRef.current;
    if (!player || !activeItem) return;
    const nextTime = Math.max(0, Number(player.currentTime?.() || 0) + delta * activeFrameInterval);
    const duration = Number(player.duration?.() || nextTime);
    player.currentTime?.(Math.min(nextTime, duration));
  };

  const markStart = () => {
    if (isValidationMode || !selectedChunk) return;
    setIntervalStartFrame(currentFrame);
  };

  const markEnd = () => {
    if (isValidationMode || !selectedChunk) return;
    if (intervalStartFrame === null) {
      setIntervalStartFrame(currentFrame);
      return;
    }
    const start = clampFrame(Math.min(intervalStartFrame, currentFrame), activeStartFrame, activeEndFrame);
    const end = clampFrame(Math.max(intervalStartFrame, currentFrame), activeStartFrame, activeEndFrame);
    commitIntervals([...intervalsRef.current, { start_frame: start, end_frame: end, confidence: 1, label: defaultLabel }]);
    setIntervalStartFrame(null);
  };

  useEffect(() => {
    intervalsRef.current = intervals;
  }, [intervals]);

  useEffect(() => {
    if (!chunkItems.length) {
      setSelectedChunkAssignmentId(null);
      return;
    }
    if (!selectedChunkAssignmentId || !chunkItems.some((item) => item.assignment_id === selectedChunkAssignmentId)) {
      setSelectedChunkAssignmentId(chunkItems[0].assignment_id);
    }
  }, [chunkItems, selectedChunkAssignmentId]);

  useEffect(() => {
    if (!validationItems.length) {
      setSelectedIntervalValidationId(null);
      return;
    }
    if (!selectedIntervalValidationId || !validationItems.some((item) => item.assignment_id === selectedIntervalValidationId)) {
      setSelectedIntervalValidationId(validationItems[0].assignment_id);
    }
  }, [selectedIntervalValidationId, validationItems]);

  useEffect(() => {
    if (!activeDraftKey) return;
    const draft = readDraft(activeDraftKey);
    if (isValidationMode) {
      setComment(draft?.comment ?? "");
      setIntervals([]);
      setIntervalStartFrame(null);
      setHistory([]);
      setFuture([]);
    } else if (draft) {
      setIntervals(draft.intervals ?? []);
      setComment(draft.comment ?? "");
      setIntervalStartFrame(draft.intervalStartFrame ?? null);
      setHistory([]);
      setFuture([]);
    } else {
      setIntervals([]);
      setComment("");
      setIntervalStartFrame(null);
      setHistory([]);
      setFuture([]);
    }
    setPlayerState({ currentTime: 0, duration: 0, paused: true, ended: false });
  }, [activeDraftKey, isValidationMode]);

  useEffect(() => {
    if (!activeDraftKey) return;
    const timeout = window.setTimeout(() => {
      writeDraft(activeDraftKey, {
        intervals: isValidationMode ? [] : intervalsRef.current,
        comment,
        intervalStartFrame: isValidationMode ? null : intervalStartFrame,
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeDraftKey, comment, intervalStartFrame, intervals, isValidationMode]);

  useEffect(() => {
    if (!statusNotice) return;
    const timeout = window.setTimeout(() => setStatusNotice(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [statusNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        const player = playerRef.current;
        if (!player) return;
        if (player.paused?.()) {
          player.play?.();
        } else {
          player.pause?.();
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepFrames(-1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFrames(1);
        return;
      }

      if (!isValidationMode && event.key.toLowerCase() === "i") {
        event.preventDefault();
        markStart();
        return;
      }

      if (!isValidationMode && event.key.toLowerCase() === "o") {
        event.preventDefault();
        markEnd();
        return;
      }

      if (!isValidationMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoIntervals();
        return;
      }

      if (!isValidationMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoIntervals();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFrameInterval, activeItem, isValidationMode, redoIntervals, stepFrames, undoIntervals]);

  const backToProject = projectIdFilter ? `/labeling/projects/${projectIdFilter}` : "/labeling";
  const stageLabel = isValidationMode ? "Этап 2" : "Этап 1";
  const pageTitle = isValidationMode ? "Валидация интервалов" : "Разметка интервалов";
  const stageNotice = isValidationMode
    ? "Это очередь уже размеченных интервалов. Здесь ничего не загружают — только проверяют и подтверждают результат."
    : "Первый экран появляется сразу, а видео-плеер подгружается лениво. Используйте In/Out, таймлайн и горячие клавиши.";

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedChunk || intervalsRef.current.length === 0) {
        throw new Error("Выберите чанк и добавьте хотя бы один интервал");
      }
      return annotatorAPI.submitIntervalChunk(selectedChunk.assignment_id, { intervals: intervalsRef.current, comment });
    },
    onSuccess: async (result: any) => {
      const nextAssignmentId = pickNextAssignmentId(chunkItems, selectedChunkAssignmentId);
      if (activeDraftKey) {
        clearDraft(activeDraftKey);
      }
      setIntervals([]);
      setComment("");
      setIntervalStartFrame(null);
      setHistory([]);
      setFuture([]);
      setSelectedChunkAssignmentId(nextAssignmentId);
      setStatusNotice({
        kind: "success",
        text: `Интервалы отправлены. Создано ${Number(result?.intervals_created || 0)} интервалов. Очередь обновлена.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["interval-chunk-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["interval-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
    },
    onError: (err: any) => {
      setStatusNotice({
        kind: "error",
        text: err?.response?.data?.detail || err?.response?.data?.error || err?.message || "Не удалось отправить интервалы.",
      });
    },
  });

  const validationMutation = useMutation({
    mutationFn: async (decision: "approved" | "rejected") => {
      if (!selectedValidation) {
        throw new Error("Выберите интервал для проверки");
      }
      return annotatorAPI.submitIntervalValidation(selectedValidation.assignment_id, {
        decision,
        comment,
      });
    },
    onSuccess: async (result: any) => {
      const nextAssignmentId = pickNextAssignmentId(validationItems, selectedIntervalValidationId);
      if (activeDraftKey) {
        clearDraft(activeDraftKey);
      }
      setComment("");
      setIntervals([]);
      setIntervalStartFrame(null);
      setHistory([]);
      setFuture([]);
      setSelectedIntervalValidationId(nextAssignmentId);
      setStatusNotice({
        kind: "success",
        text: `Решение отправлено. Текущий статус: ${String(result?.interval_status || "updated")}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["interval-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
    },
    onError: (err: any) => {
      setStatusNotice({
        kind: "error",
        text: err?.response?.data?.detail || err?.response?.data?.error || err?.message || "Не удалось отправить решение проверки.",
      });
    },
  });

  const renderChunkControls = () => (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr),320px]">
      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Разметка</div>
              <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">
                Кадр {currentFrame} · {formatSeconds(playerState.currentTime)} / {totalTimeLabel}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" type="button" onClick={() => stepFrames(-1)}>
                -1 frame
              </button>
              <button className="btn-secondary" type="button" onClick={() => stepFrames(1)}>
                +1 frame
              </button>
              <button className="btn-secondary" type="button" onClick={markStart}>
                In
              </button>
              <button className="btn-secondary" type="button" onClick={markEnd}>
                Out
              </button>
              <button className="btn-secondary" type="button" onClick={undoIntervals} disabled={history.length === 0}>
                Undo
              </button>
              <button className="btn-secondary" type="button" onClick={redoIntervals} disabled={future.length === 0}>
                Redo
              </button>
            </div>
          </div>
          <div className="mt-3">
            <TimelineStrip
              startFrame={activeStartFrame}
              endFrame={activeEndFrame}
              currentFrame={currentFrame}
              intervals={intervals}
              draftStartFrame={intervalStartFrame}
              onSeekFrame={seekFrame}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>Горячие клавиши: Space play/pause, I in, O out, стрелки шаг, Ctrl+Z undo, Ctrl+Y redo.</span>
          </div>
        </div>

        <VideoJsPlayer
          key={selectedChunk?.assignment_id || "chunk-empty"}
          src={mediaSrc}
          initialTime={0}
          onReady={(player) => {
            playerRef.current = player;
          }}
          onStateChange={setPlayerState}
          onError={(message) => {
            setStatusNotice({ kind: "error", text: message });
          }}
        />

        <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-900 dark:text-white">Интервалы</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Черновик сохраняется автоматически в браузере.</div>
            </div>
            <button className="btn-primary" type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || intervals.length === 0}>
              {saveMutation.isPending ? "Отправка..." : "Отправить интервалы"}
            </button>
          </div>

          <div className="space-y-2">
            {intervals.map((interval, index) => (
              <div key={`${interval.start_frame}-${interval.end_frame}-${index}`} className="grid grid-cols-[1fr,1fr,auto] gap-2 rounded-lg border border-gray-200 p-2 text-sm dark:border-gray-800">
                <input
                  className="input-field"
                  type="number"
                  value={interval.start_frame}
                  onChange={(event) => updateInterval(index, { start_frame: clampFrame(Number(event.target.value || 0), activeStartFrame, activeEndFrame) })}
                />
                <input
                  className="input-field"
                  type="number"
                  value={interval.end_frame}
                  onChange={(event) => updateInterval(index, { end_frame: clampFrame(Number(event.target.value || 0), activeStartFrame, activeEndFrame) })}
                />
                <button className="btn-secondary" type="button" onClick={() => removeInterval(index)}>
                  Удалить
                </button>
              </div>
            ))}
            {intervals.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
                Поставьте In и Out на нужных кадрах или нажмите кнопки на таймлайне.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="text-sm font-medium text-gray-900 dark:text-white">Комментарий</div>
          <textarea
            className="input-field mt-3 min-h-[120px]"
            placeholder="Комментарий к интервалам"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">Автосохранение включено.</div>
        </div>
      </div>
    </div>
  );

  const renderValidationControls = () => (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr),320px]">
      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Проверка</div>
              <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">
                Интервал {selectedValidation?.start_frame}-{selectedValidation?.end_frame} · {formatSeconds(activeDurationSec)}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" type="button" onClick={() => stepFrames(-1)}>
                -1 frame
              </button>
              <button className="btn-secondary" type="button" onClick={() => stepFrames(1)}>
                +1 frame
              </button>
              <button className="btn-secondary" type="button" onClick={() => seekFrame(selectedValidation?.start_frame || activeStartFrame)}>
                К началу
              </button>
              <button className="btn-secondary" type="button" onClick={() => seekFrame(selectedValidation?.end_frame || activeEndFrame)}>
                К концу
              </button>
            </div>
          </div>
          <div className="mt-3">
            <TimelineStrip
              startFrame={activeStartFrame}
              endFrame={activeEndFrame}
              currentFrame={currentFrame}
              intervals={[]}
              draftStartFrame={null}
              onSeekFrame={seekFrame}
            />
          </div>
          <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Отрывок интервала с небольшим контекстом. Границы clip: {selectedValidation?.clip?.start_sec?.toFixed?.(1) ?? validationClipStartSec.toFixed(1)}-
            {(Number(selectedValidation?.clip?.start_sec || 0) + Number(selectedValidation?.clip?.duration_sec || 0)).toFixed(1)} с.
          </div>
        </div>

        <VideoJsPlayer
          key={selectedValidation?.assignment_id || "validation-empty"}
          src={mediaSrc}
          initialTime={0}
          onReady={(player) => {
            playerRef.current = player;
          }}
          onStateChange={setPlayerState}
          onError={(message) => {
            setStatusNotice({ kind: "error", text: message });
          }}
        />
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="text-sm font-medium text-gray-900 dark:text-white">Комментарий к проверке</div>
          <textarea
            className="input-field mt-3 min-h-[120px]"
            placeholder="Комментарий к валидации"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn-primary" type="button" onClick={() => validationMutation.mutate("approved")} disabled={validationMutation.isPending}>
              Подтвердить
            </button>
            <button className="btn-secondary" type="button" onClick={() => validationMutation.mutate("rejected")} disabled={validationMutation.isPending}>
              Отклонить
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-[calc(100vh-6rem)] space-y-4">
      <div className="sticky top-0 z-20 -mx-4 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{stageLabel}</div>
            <h1 className="truncate text-xl font-semibold text-gray-900 dark:text-white">{pageTitle}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className={!isValidationMode ? "btn-primary" : "btn-secondary"} to={`/labeling/intervals${projectIdFilter ? `?projectId=${projectIdFilter}&stage=intervals` : ""}`}>
              Разметка
            </Link>
            <Link className={isValidationMode ? "btn-primary" : "btn-secondary"} to={`/labeling/intervals${projectIdFilter ? `?projectId=${projectIdFilter}&stage=interval-validation` : "?stage=interval-validation"}`}>
              Валидация
            </Link>
            <Link className="btn-secondary" to={backToProject}>
              К проекту
            </Link>
          </div>
        </div>
      </div>

      {statusNotice ? (
        <div
          className={`rounded-lg border p-3 text-sm ${
            statusNotice.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
          }`}
        >
          {statusNotice.text}
        </div>
      ) : null}

      <div className={`rounded-xl border p-3 text-sm ${isValidationMode ? "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100" : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"}`}>
        {stageNotice}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(220px,320px),minmax(0,1fr)]">
        <aside className="space-y-2 xl:max-h-[calc(100vh-12rem)] xl:overflow-auto">
          <div className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
            <div className="text-sm font-medium text-gray-900 dark:text-white">
              {isValidationMode ? "Очередь валидации" : "Очередь чанкoв"}
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{isValidationMode ? `${validationItems.length} задач` : `${chunkItems.length} задач`}</div>
          </div>

          {(isValidationMode ? validationItems : chunkItems).map((item: any) => {
            const isSelected = activeAssignmentId === item.assignment_id;
            const title = item.project_title;
            const details = isValidationMode
              ? `${item.start_frame}-${item.end_frame} · ${formatSeconds(Number(item.duration_sec || 0))}`
              : `Кадры ${item.start_frame}-${item.end_frame} · ${formatSeconds(Number(item.duration_sec || 0))}`;

            return (
              <button
                key={item.assignment_id}
                className={`w-full rounded-xl border p-3 text-left transition ${
                  isSelected ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"
                }`}
                onClick={() => {
                  if (isValidationMode) {
                    setSelectedIntervalValidationId(item.assignment_id);
                  } else {
                    setSelectedChunkAssignmentId(item.assignment_id);
                  }
                  playerRef.current?.pause?.();
                  setPlayerState({ currentTime: 0, duration: 0, paused: true, ended: false });
                }}
              >
                <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{title}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{details}</div>
              </button>
            );
          })}

          {(isValidationMode ? validationItems : chunkItems).length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
              {isValidationMode ? "Нет задач валидации интервалов." : "Нет задач разметки интервалов."}
            </div>
          ) : null}
        </aside>

        <main className="space-y-4">
          {activeItem ? (
            isValidationMode ? renderValidationControls() : renderChunkControls()
          ) : (
            <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">
              {isValidationMode ? "Выберите интервал для проверки." : "Выберите чанк из очереди."}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
