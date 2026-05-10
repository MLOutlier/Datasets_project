import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";

type IntervalDraft = {
  start_frame: number;
  end_frame: number;
  confidence?: number;
  label?: string;
};

function clampFrame(value: number, start: number, end: number) {
  return Math.min(Math.max(Math.round(value), start), end);
}

function frameToTime(frame: number, intervalSec: number) {
  return Math.max(0, frame * Math.max(intervalSec || 1, 0.1));
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return "0.0 c";
  return `${value.toFixed(1)} c`;
}

function chunkDuration(item: any) {
  const provided = Number(item?.duration_sec);
  if (Number.isFinite(provided) && provided > 0) return provided;
  const intervalSec = Number(item?.frame_interval_sec || 1);
  return Math.max(0, (Number(item?.end_frame || 0) - Number(item?.start_frame || 0)) * intervalSec);
}

export default function VideoIntervalsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdFilter = searchParams.get("projectId") || "";
  const stageFilter = searchParams.get("stage") || "intervals";
  const isValidationMode = stageFilter === "interval-validation";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const validationVideoRef = useRef<HTMLVideoElement | null>(null);
  const [selectedChunkAssignmentId, setSelectedChunkAssignmentId] = useState<string | null>(null);
  const [selectedIntervalValidationId, setSelectedIntervalValidationId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [intervalStartFrame, setIntervalStartFrame] = useState<number | null>(null);
  const [intervals, setIntervals] = useState<IntervalDraft[]>([]);

  const chunkQueueQuery = useQuery({ queryKey: ["interval-chunk-queue"], queryFn: () => annotatorAPI.intervalChunkQueue() });
  const intervalValidationQueueQuery = useQuery({ queryKey: ["interval-validation-queue"], queryFn: () => annotatorAPI.intervalValidationQueue() });

  const chunkItems = useMemo(
    () => (chunkQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter),
    [chunkQueueQuery.data?.items, projectIdFilter]
  );
  const intervalValidationItems = useMemo(
    () => (intervalValidationQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter),
    [intervalValidationQueueQuery.data?.items, projectIdFilter]
  );

  const selectedChunk = useMemo(
    () => chunkItems.find((item: any) => item.assignment_id === selectedChunkAssignmentId) ?? chunkItems[0] ?? null,
    [chunkItems, selectedChunkAssignmentId]
  );
  const selectedIntervalValidation = useMemo(
    () => intervalValidationItems.find((item: any) => item.assignment_id === selectedIntervalValidationId) ?? intervalValidationItems[0] ?? null,
    [intervalValidationItems, selectedIntervalValidationId]
  );
  const selectedIntervalClip = selectedIntervalValidation?.clip?.clip_uri || selectedIntervalValidation?.clip?.uri || selectedIntervalValidation?.asset_uri || "";
  const backToProject = projectIdFilter ? `/labeling/projects/${projectIdFilter}` : "/labeling";

  useEffect(() => {
    if (!selectedChunkAssignmentId && selectedChunk?.assignment_id) setSelectedChunkAssignmentId(selectedChunk.assignment_id);
  }, [selectedChunk?.assignment_id, selectedChunkAssignmentId]);

  useEffect(() => {
    if (!selectedIntervalValidationId && selectedIntervalValidation?.assignment_id) {
      setSelectedIntervalValidationId(selectedIntervalValidation.assignment_id);
    }
  }, [selectedIntervalValidation?.assignment_id, selectedIntervalValidationId]);

  const currentFrame = () => {
    if (!selectedChunk || !videoRef.current) return selectedChunk?.start_frame ?? 0;
    const intervalSec = Number(selectedChunk.frame_interval_sec || 1);
    return clampFrame(videoRef.current.currentTime / intervalSec, selectedChunk.start_frame, selectedChunk.end_frame);
  };

  const seekChunkFrame = (frame: number) => {
    if (!selectedChunk || !videoRef.current) return;
    videoRef.current.currentTime = frameToTime(frame, Number(selectedChunk.frame_interval_sec || 1));
  };

  const seekValidationFrame = (frame: number) => {
    if (!selectedIntervalValidation || !validationVideoRef.current) return;
    const absoluteTime = frameToTime(frame, Number(selectedIntervalValidation.frame_interval_sec || 1));
    const clipStart = Number(selectedIntervalValidation?.clip?.start_sec ?? 0);
    validationVideoRef.current.currentTime = selectedIntervalValidation?.clip?.clip_uri ? Math.max(0, absoluteTime - clipStart) : absoluteTime;
  };

  const saveMutation = useMutation({
    mutationFn: async () => annotatorAPI.submitIntervalChunk(selectedChunkAssignmentId!, { intervals, comment }),
    onSuccess: async () => {
      setComment("");
      setIntervals([]);
      setIntervalStartFrame(null);
      setSelectedChunkAssignmentId(null);
      await queryClient.invalidateQueries({ queryKey: ["interval-chunk-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["interval-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
    },
  });

  const intervalValidateMutation = useMutation({
    mutationFn: async (decision: "approved" | "rejected") =>
      annotatorAPI.submitIntervalValidation(selectedIntervalValidationId!, {
        decision,
        comment,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["interval-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
      setSelectedIntervalValidationId(null);
      setComment("");
    },
  });

  const addIntervalPoint = () => {
    if (!selectedChunk) return;
    const frame = currentFrame();
    if (intervalStartFrame === null) {
      setIntervalStartFrame(frame);
      return;
    }
    const start = clampFrame(Math.min(intervalStartFrame, frame), selectedChunk.start_frame, selectedChunk.end_frame);
    const end = clampFrame(Math.max(intervalStartFrame, frame), selectedChunk.start_frame, selectedChunk.end_frame);
    if (end >= start) {
      setIntervals((prev) => [...prev, { start_frame: start, end_frame: end, confidence: 1, label: "object" }]);
    }
    setIntervalStartFrame(null);
  };

  const activeItem = isValidationMode ? selectedIntervalValidation : selectedChunk;
  const activeDuration = chunkDuration(activeItem);
  const durationTone =
    activeDuration > 60
      ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200";
  const validationClipDuration = Number(selectedIntervalValidation?.clip?.duration_sec || selectedIntervalValidation?.duration_sec || 0);

  return (
    <div className="min-h-[calc(100vh-6rem)] space-y-4">
      <div className="sticky top-0 z-20 -mx-4 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {isValidationMode ? "Этап 2" : "Этап 1"}
            </div>
            <h1 className="truncate text-xl font-semibold text-gray-900 dark:text-white">
              {isValidationMode ? "Валидация интервалов" : "Разметка интервалов"}
            </h1>
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

      {!isValidationMode ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(220px,320px),minmax(0,1fr)]">
          <aside className="space-y-2 xl:max-h-[calc(100vh-12rem)] xl:overflow-auto">
            <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Очередь чанков</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{chunkItems.length} задач</div>
            </div>
            {chunkItems.map((item: any) => (
              <button
                key={item.assignment_id}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  selectedChunk?.assignment_id === item.assignment_id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"
                }`}
                onClick={() => {
                  setSelectedChunkAssignmentId(item.assignment_id);
                  setIntervals([]);
                  setIntervalStartFrame(null);
                }}
              >
                <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{item.project_title}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Кадры {item.start_frame}-{item.end_frame} · {formatSeconds(chunkDuration(item))}
                </div>
              </button>
            ))}
            {chunkItems.length === 0 ? <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">Нет задач разметки интервалов.</div> : null}
          </aside>

          <main className="space-y-4">
            {selectedChunk ? (
              <>
                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="btn-secondary" type="button" onClick={() => seekChunkFrame(selectedChunk.start_frame)}>
                        К началу
                      </button>
                      <button className="btn-secondary" type="button" onClick={() => seekChunkFrame(selectedChunk.end_frame)}>
                        К концу
                      </button>
                      <button className="btn-primary" type="button" onClick={addIntervalPoint}>
                        {intervalStartFrame === null ? "Поставить начало" : "Поставить конец"}
                      </button>
                    </div>
                    <div className={`rounded-lg border px-3 py-2 text-sm ${durationTone}`}>{formatSeconds(activeDuration)}</div>
                  </div>
                  {intervalStartFrame !== null ? <div className="mt-2 text-sm text-blue-600 dark:text-blue-300">Начало интервала: кадр {intervalStartFrame}</div> : null}
                </div>

                <div className="flex justify-center rounded-lg bg-neutral-950 p-2">
                  <video ref={videoRef} className="max-h-[68vh] w-full max-w-6xl rounded bg-black object-contain" src={selectedChunk.asset_uri} controls />
                </div>

                <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr),320px]">
                  <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                    <div className="mb-3 text-sm font-medium text-gray-900 dark:text-white">Интервалы</div>
                    <div className="space-y-2">
                      {intervals.map((interval, index) => (
                        <div key={`${interval.start_frame}-${interval.end_frame}-${index}`} className="grid grid-cols-[1fr,1fr,auto] gap-2 rounded-lg border border-gray-200 p-2 text-sm dark:border-gray-800">
                          <input
                            className="input-field"
                            type="number"
                            value={interval.start_frame}
                            onChange={(event) => {
                              const value = clampFrame(Number(event.target.value || 0), selectedChunk.start_frame, selectedChunk.end_frame);
                              setIntervals((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, start_frame: value } : item)));
                            }}
                          />
                          <input
                            className="input-field"
                            type="number"
                            value={interval.end_frame}
                            onChange={(event) => {
                              const value = clampFrame(Number(event.target.value || 0), selectedChunk.start_frame, selectedChunk.end_frame);
                              setIntervals((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, end_frame: value } : item)));
                            }}
                          />
                          <button className="btn-secondary" type="button" onClick={() => setIntervals((prev) => prev.filter((_, i) => i !== index))}>
                            Удалить
                          </button>
                        </div>
                      ))}
                      {intervals.length === 0 ? <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">Поставьте начало и конец интервала по текущему времени видео.</div> : null}
                    </div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                    <textarea className="input-field min-h-[120px]" placeholder="Комментарий к интервалам" value={comment} onChange={(event) => setComment(event.target.value)} />
                    <button className="btn-primary mt-3 w-full" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                      {saveMutation.isPending ? "Отправка..." : "Отправить интервалы"}
                    </button>
                  </div>
                </section>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">Выберите чанк из очереди.</div>
            )}
          </main>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(220px,320px),minmax(0,1fr)]">
          <aside className="space-y-2 xl:max-h-[calc(100vh-12rem)] xl:overflow-auto">
            <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Очередь валидации</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{intervalValidationItems.length} задач</div>
            </div>
            {intervalValidationItems.map((item: any) => (
              <button
                key={item.assignment_id}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  selectedIntervalValidation?.assignment_id === item.assignment_id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"
                }`}
                onClick={() => setSelectedIntervalValidationId(item.assignment_id)}
              >
                <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{item.project_title}</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Интервал {item.start_frame}-{item.end_frame} · {formatSeconds(chunkDuration(item))}
                </div>
              </button>
            ))}
            {intervalValidationItems.length === 0 ? <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">Нет задач валидации интервалов.</div> : null}
          </aside>

          <main className="space-y-4">
            {selectedIntervalValidation ? (
              <>
                <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="btn-secondary" type="button" onClick={() => seekValidationFrame(selectedIntervalValidation.start_frame)}>
                        К началу
                      </button>
                      <button className="btn-secondary" type="button" onClick={() => seekValidationFrame(selectedIntervalValidation.end_frame)}>
                        К концу
                      </button>
                    </div>
                    <div className={`rounded-lg border px-3 py-2 text-sm ${durationTone}`}>
                      {selectedIntervalValidation.start_frame}-{selectedIntervalValidation.end_frame} · {formatSeconds(validationClipDuration || activeDuration)}
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Отрывок интервала с небольшим контекстом. Границы: {selectedIntervalValidation.start_sec?.toFixed?.(1) ?? Number(selectedIntervalValidation.start_sec || 0).toFixed(1)}-
                    {selectedIntervalValidation.end_sec?.toFixed?.(1) ?? Number(selectedIntervalValidation.end_sec || 0).toFixed(1)} сек.
                  </div>
                </div>

                <div className="flex justify-center rounded-lg bg-neutral-950 p-2">
                  <video ref={validationVideoRef} className="max-h-[68vh] w-full max-w-6xl rounded bg-black object-contain" src={selectedIntervalClip} controls />
                </div>

                <section className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                  <textarea className="input-field min-h-[96px]" placeholder="Комментарий к валидации" value={comment} onChange={(event) => setComment(event.target.value)} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="btn-primary" onClick={() => intervalValidateMutation.mutate("approved")} disabled={intervalValidateMutation.isPending}>
                      Подтвердить
                    </button>
                    <button className="btn-secondary" onClick={() => intervalValidateMutation.mutate("rejected")} disabled={intervalValidateMutation.isPending}>
                      Отклонить
                    </button>
                  </div>
                </section>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">Выберите интервал для проверки.</div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
