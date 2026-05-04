import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";

type IntervalDraft = {
  start_frame: number;
  end_frame: number;
  confidence?: number;
  label?: string;
};

type Decision = "approve" | "needs_changes";

function clampFrame(value: number, start: number, end: number) {
  return Math.min(Math.max(Math.round(value), start), end);
}

function frameToTime(frame: number, intervalSec: number) {
  return Math.max(0, frame * Math.max(intervalSec || 1, 0.1));
}

function BoxOverlay({ item, boxes }: { item: any; boxes: any[] }) {
  return (
    <div className="relative h-56 w-full overflow-hidden rounded-lg border border-gray-200 bg-black dark:border-gray-800">
      <img src={item.frame_url} alt={`Frame ${item.frame_number}`} className="h-full w-full object-contain" />
      {(boxes ?? []).map((box, index) => (
        <div
          key={`${item.work_item_id ?? item.golden_id}-${index}`}
          className="absolute border-2 border-emerald-400"
          style={{
            left: `${(Number(box.x || 0) / Math.max(Number(item.width || 1), 1)) * 100}%`,
            top: `${(Number(box.y || 0) / Math.max(Number(item.height || 1), 1)) * 100}%`,
            width: `${(Number(box.width || 0) / Math.max(Number(item.width || 1), 1)) * 100}%`,
            height: `${(Number(box.height || 0) / Math.max(Number(item.height || 1), 1)) * 100}%`,
            borderColor: box.color || "#34d399",
          }}
          title={box.label}
        />
      ))}
    </div>
  );
}

export default function VideoIntervalsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdFilter = searchParams.get("projectId") || "";
  const stageFilter = searchParams.get("stage") || "";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const validationVideoRef = useRef<HTMLVideoElement | null>(null);
  const [selectedChunkAssignmentId, setSelectedChunkAssignmentId] = useState<string | null>(null);
  const [selectedIntervalValidationId, setSelectedIntervalValidationId] = useState<string | null>(null);
  const [selectedBBoxValidationId, setSelectedBBoxValidationId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [intervalStartFrame, setIntervalStartFrame] = useState<number | null>(null);
  const [intervals, setIntervals] = useState<IntervalDraft[]>([]);
  const [bboxDecisions, setBBoxDecisions] = useState<Record<string, Decision>>({});
  const [goldenDecisions, setGoldenDecisions] = useState<Record<string, Decision>>({});

  const chunkQueueQuery = useQuery({
    queryKey: ["interval-chunk-queue"],
    queryFn: () => annotatorAPI.intervalChunkQueue(),
  });
  const intervalValidationQueueQuery = useQuery({
    queryKey: ["interval-validation-queue"],
    queryFn: () => annotatorAPI.intervalValidationQueue(),
  });
  const bboxValidationQueueQuery = useQuery({
    queryKey: ["bbox-validation-queue"],
    queryFn: () => annotatorAPI.bboxValidationQueue(),
  });

  const selectedChunk = useMemo(
    () => (chunkQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter).find((item: any) => item.assignment_id === selectedChunkAssignmentId) ?? null,
    [chunkQueueQuery.data?.items, projectIdFilter, selectedChunkAssignmentId]
  );
  const selectedIntervalValidation = useMemo(
    () => (intervalValidationQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter).find((item: any) => item.assignment_id === selectedIntervalValidationId) ?? null,
    [intervalValidationQueueQuery.data?.items, projectIdFilter, selectedIntervalValidationId]
  );
  const selectedBBoxValidation = useMemo(
    () => (bboxValidationQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter).find((item: any) => item.assignment_id === selectedBBoxValidationId) ?? null,
    [bboxValidationQueueQuery.data?.items, projectIdFilter, selectedBBoxValidationId]
  );
  const chunkItems = useMemo(
    () => (chunkQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter),
    [chunkQueueQuery.data?.items, projectIdFilter]
  );
  const intervalValidationItems = useMemo(
    () => (intervalValidationQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter),
    [intervalValidationQueueQuery.data?.items, projectIdFilter]
  );
  const bboxValidationItems = useMemo(
    () => (bboxValidationQueueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter),
    [bboxValidationQueueQuery.data?.items, projectIdFilter]
  );
  const backToProject = projectIdFilter ? `/labeling/projects/${projectIdFilter}` : "/labeling";

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
    validationVideoRef.current.currentTime = frameToTime(frame, Number(selectedIntervalValidation.frame_interval_sec || 1));
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

  const bboxSubmitMutation = useMutation({
    mutationFn: async () => {
      const task = selectedBBoxValidation;
      if (!task) throw new Error("Validation assignment not selected");
      const decisions: Record<string, string> = {};
      const golden: Record<string, string> = {};
      (task.real_items ?? []).forEach((id: string) => {
        decisions[id] = bboxDecisions[id] ?? "approve";
      });
      (task.golden_items ?? []).forEach((id: string) => {
        golden[id] = goldenDecisions[id] ?? "approve";
      });
      return annotatorAPI.submitBBoxValidation(task.assignment_id, { decisions, golden_decisions: golden });
    },
    onSuccess: async () => {
      setSelectedBBoxValidationId(null);
      setBBoxDecisions({});
      setGoldenDecisions({});
      await queryClient.invalidateQueries({ queryKey: ["bbox-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
    },
  });

  const addIntervalEnd = () => {
    if (!selectedChunk) return;
    const endFrame = currentFrame();
    if (intervalStartFrame === null) {
      setIntervalStartFrame(endFrame);
      return;
    }
    const start = Math.min(intervalStartFrame, endFrame);
    const end = Math.max(intervalStartFrame, endFrame);
    setIntervals((prev) => [...prev, { start_frame: start, end_frame: end, confidence: 1, label: "object" }]);
    setIntervalStartFrame(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Очереди 4-step workflow</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {projectIdFilter
              ? "Показаны задачи только выбранного проекта."
              : "Этапы 1, 2 и 4 выполняются исполнителями. BBox-разметка открывается из карточки конкретного проекта."}
          </p>
        </div>
        <Link className="btn-secondary" to={backToProject}>Назад к проекту</Link>
      </div>

      <div className={`card space-y-4 ${stageFilter && stageFilter !== "intervals" ? "opacity-70" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Этап 1: выделение интервалов видео</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Выберите чанк, поставьте начало и конец интервала по текущему времени видео.</p>
          </div>
          <span className="badge badge-warning">{chunkItems.length} задач</span>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.45fr,0.55fr]">
          <div className="space-y-2">
            {chunkItems.map((item: any) => (
              <button
                key={item.assignment_id}
                className={`w-full rounded border p-3 text-left ${selectedChunkAssignmentId === item.assignment_id ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-800"}`}
                onClick={() => {
                  setSelectedChunkAssignmentId(item.assignment_id);
                  setIntervals([]);
                  setIntervalStartFrame(null);
                }}
              >
                <div className="text-sm font-medium">{item.project_title}</div>
                <div className="text-xs text-gray-500">Кадры: {item.start_frame}-{item.end_frame}</div>
              </button>
            ))}
            {chunkItems.length === 0 ? <div className="text-sm text-gray-500">Нет задач разметки интервалов.</div> : null}
          </div>

          <div className="space-y-4">
            {selectedChunk ? (
              <>
                <video ref={videoRef} className="aspect-video w-full rounded-lg bg-black" src={selectedChunk.asset_uri} controls />
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary" type="button" onClick={() => seekChunkFrame(selectedChunk.start_frame)}>К началу чанка</button>
                  <button className="btn-secondary" type="button" onClick={() => seekChunkFrame(selectedChunk.end_frame)}>К концу чанка</button>
                  <button className="btn-primary" type="button" onClick={addIntervalEnd}>
                    {intervalStartFrame === null ? "Поставить начало" : "Поставить конец"}
                  </button>
                </div>
                {intervalStartFrame !== null ? <div className="text-sm text-blue-600 dark:text-blue-300">Начало интервала: кадр {intervalStartFrame}</div> : null}
                <div className="space-y-2">
                  {intervals.map((interval, index) => (
                    <div key={`${interval.start_frame}-${interval.end_frame}-${index}`} className="grid grid-cols-1 gap-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800 md:grid-cols-[1fr,1fr,auto]">
                      <input
                        className="input-field"
                        type="number"
                        value={interval.start_frame}
                        onChange={(event) => {
                          const value = Number(event.target.value || 0);
                          setIntervals((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, start_frame: value } : item));
                        }}
                      />
                      <input
                        className="input-field"
                        type="number"
                        value={interval.end_frame}
                        onChange={(event) => {
                          const value = Number(event.target.value || 0);
                          setIntervals((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, end_frame: value } : item));
                        }}
                      />
                      <button className="btn-secondary" type="button" onClick={() => setIntervals((prev) => prev.filter((_, i) => i !== index))}>Удалить</button>
                    </div>
                  ))}
                </div>
                <textarea className="input-field min-h-[80px]" placeholder="Комментарий к интервалам" value={comment} onChange={(event) => setComment(event.target.value)} />
                <button className="btn-primary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? "Отправка..." : "Отправить интервалы"}
                </button>
              </>
            ) : (
              <div className="rounded-lg border border-gray-200 p-6 text-sm text-gray-500 dark:border-gray-800">Выберите чанк из очереди.</div>
            )}
          </div>
        </div>
      </div>

      <div className={`card space-y-4 ${stageFilter && stageFilter !== "interval-validation" ? "opacity-70" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Этап 2: валидация интервалов</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Проверьте интервал другого исполнителя по исходному видео.</p>
          </div>
          <span className="badge badge-warning">{intervalValidationItems.length} задач</span>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.45fr,0.55fr]">
          <div className="space-y-2">
            {intervalValidationItems.map((item: any) => (
              <button
                key={item.assignment_id}
                className={`w-full rounded border p-3 text-left ${selectedIntervalValidationId === item.assignment_id ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-800"}`}
                onClick={() => setSelectedIntervalValidationId(item.assignment_id)}
              >
                <div className="text-sm font-medium">{item.project_title}</div>
                <div className="text-xs text-gray-500">Интервал: {item.start_frame}-{item.end_frame}</div>
              </button>
            ))}
            {intervalValidationItems.length === 0 ? <div className="text-sm text-gray-500">Нет задач валидации интервалов.</div> : null}
          </div>
          <div className="space-y-4">
            {selectedIntervalValidation ? (
              <>
                <video ref={validationVideoRef} className="aspect-video w-full rounded-lg bg-black" src={selectedIntervalValidation.asset_uri} controls />
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary" type="button" onClick={() => seekValidationFrame(selectedIntervalValidation.start_frame)}>К началу интервала</button>
                  <button className="btn-secondary" type="button" onClick={() => seekValidationFrame(selectedIntervalValidation.end_frame)}>К концу интервала</button>
                </div>
                <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
                  Кадры {selectedIntervalValidation.start_frame}-{selectedIntervalValidation.end_frame}
                  <span className="ml-2 text-gray-500">({Number(selectedIntervalValidation.start_sec ?? 0).toFixed(1)}-{Number(selectedIntervalValidation.end_sec ?? 0).toFixed(1)} сек.)</span>
                </div>
                <textarea className="input-field min-h-[80px]" placeholder="Комментарий к валидации" value={comment} onChange={(event) => setComment(event.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" onClick={() => intervalValidateMutation.mutate("approved")} disabled={intervalValidateMutation.isPending}>Подтвердить</button>
                  <button className="btn-secondary" onClick={() => intervalValidateMutation.mutate("rejected")} disabled={intervalValidateMutation.isPending}>Отклонить</button>
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-gray-200 p-6 text-sm text-gray-500 dark:border-gray-800">Выберите интервал для проверки.</div>
            )}
          </div>
        </div>
      </div>

      <div className={`card space-y-4 ${stageFilter && stageFilter !== "bbox-validation" ? "opacity-70" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Этап 4: bbox-валидация</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Пакет содержит реальные кадры и golden-вопросы. Решения применятся только при точности golden ≥80%.</p>
          </div>
          <span className="badge badge-warning">{bboxValidationItems.length} задач</span>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.35fr,0.65fr]">
          <div className="space-y-2">
            {bboxValidationItems.map((item: any) => (
              <button
                key={item.assignment_id}
                className={`w-full rounded border p-3 text-left text-sm ${selectedBBoxValidationId === item.assignment_id ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-800"}`}
                onClick={() => setSelectedBBoxValidationId(item.assignment_id)}
              >
                <div className="font-medium">{item.project_title}</div>
                <div className="text-xs text-gray-500">Real: {item.real_count} | Golden: {item.golden_count}</div>
              </button>
            ))}
            {bboxValidationItems.length === 0 ? <div className="text-sm text-gray-500">Нет задач bbox-валидации.</div> : null}
          </div>

          {selectedBBoxValidation ? (
            <div className="space-y-5">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Реальные кадры</h3>
                {(selectedBBoxValidation.real_item_details ?? []).map((item: any) => {
                  const state = bboxDecisions[item.work_item_id] ?? "approve";
                  return (
                    <div key={item.work_item_id} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-gray-900 dark:text-white">Кадр #{item.frame_number}</div>
                        <select
                          className="input-field max-w-[220px]"
                          value={state}
                          onChange={(event) => setBBoxDecisions((prev) => ({ ...prev, [item.work_item_id]: event.target.value as Decision }))}
                        >
                          <option value="approve">Принять</option>
                          <option value="needs_changes">На доработку</option>
                        </select>
                      </div>
                      <BoxOverlay item={item} boxes={item.final_annotation?.boxes ?? []} />
                    </div>
                  );
                })}
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Golden-вопросы</h3>
                {(selectedBBoxValidation.golden_item_details ?? []).map((item: any) => {
                  const state = goldenDecisions[item.golden_id] ?? "approve";
                  return (
                    <div key={item.golden_id} className="rounded-lg border border-amber-200 p-3 dark:border-amber-900">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-gray-900 dark:text-white">Контрольный кадр #{item.frame_number}</div>
                        <select
                          className="input-field max-w-[220px]"
                          value={state}
                          onChange={(event) => setGoldenDecisions((prev) => ({ ...prev, [item.golden_id]: event.target.value as Decision }))}
                        >
                          <option value="approve">Принять</option>
                          <option value="needs_changes">На доработку</option>
                        </select>
                      </div>
                      <BoxOverlay item={item} boxes={item.candidate_annotation?.boxes ?? []} />
                    </div>
                  );
                })}
              </div>

              <button className="btn-primary" onClick={() => bboxSubmitMutation.mutate()} disabled={bboxSubmitMutation.isPending}>
                {bboxSubmitMutation.isPending ? "Отправка..." : "Отправить bbox-валидацию"}
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 p-6 text-sm text-gray-500 dark:border-gray-800">Выберите пакет bbox-валидации.</div>
          )}
        </div>
      </div>
    </div>
  );
}
