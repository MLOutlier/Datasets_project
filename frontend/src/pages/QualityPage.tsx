import React, { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { validationAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

type DecisionMap = Record<string, { decision: "approve" | "needs_changes"; comment: string }>;

export function QualityPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [selectedBatchKey, setSelectedBatchKey] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [batchComment, setBatchComment] = useState("");

  const queueQuery = useQuery({
    queryKey: ["validation-queue"],
    queryFn: () => validationAPI.queue(),
    enabled: user?.role === "customer" || user?.role === "admin",
  });

  const selectedQueueItem = useMemo(
    () => queueQuery.data?.items.find((item) => `${item.project_id}:${item.task_batch_id}` === selectedBatchKey) ?? null,
    [queueQuery.data?.items, selectedBatchKey]
  );

  useEffect(() => {
    if (!selectedBatchKey && queueQuery.data?.items?.length) {
      const first = queueQuery.data.items[0];
      setSelectedBatchKey(`${first.project_id}:${first.task_batch_id}`);
    }
  }, [queueQuery.data, selectedBatchKey]);

  const batchDetailQuery = useQuery({
    queryKey: ["validation-batch-detail", selectedQueueItem?.project_id, selectedQueueItem?.task_batch_id],
    queryFn: () => validationAPI.batchDetail(selectedQueueItem!.project_id, selectedQueueItem!.task_batch_id),
    enabled: !!selectedQueueItem,
  });

  useEffect(() => {
    if (!batchDetailQuery.data) return;
    const next: DecisionMap = {};
    for (const item of batchDetailQuery.data.items) {
      next[item.work_item_id] = {
        decision: item.validation_status === "needs_changes" ? "needs_changes" : "approve",
        comment: item.validation_comment || "",
      };
    }
    setDecisions(next);
    setBatchComment("");
  }, [batchDetailQuery.data?.task_batch_id]);

  const resolveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedQueueItem) throw new Error("Пакет не выбран");
      return validationAPI.resolveBatch(selectedQueueItem.project_id, selectedQueueItem.task_batch_id, {
        items: Object.entries(decisions).map(([work_item_id, value]) => ({
          work_item_id,
          decision: value.decision,
          comment: value.comment,
        })),
        batch_comment: batchComment,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["validation-batch-detail", selectedQueueItem?.project_id, selectedQueueItem?.task_batch_id] });
    },
  });

  if (user?.role !== "customer" && user?.role !== "admin") {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">🔍 Валидация</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Этот раздел доступен владельцам проектов и администраторам.</p>
      </div>
    );
  }

  const queueItems = queueQuery.data?.items ?? [];

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.88fr,1.12fr]">
      {/* Левая колонка: очередь пакетов */}
      <div className="card">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">📋 Очередь валидации</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Здесь отображаются пакеты кадров, готовые к проверке. Выберите пакет, просмотрите разметку и примите решение по каждому кадру.
        </p>

        {queueQuery.isLoading ? (
          <div className="mt-6 flex justify-center"><LoadingSpinner size="lg" /></div>
        ) : queueItems.length === 0 ? (
          <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
            В очереди валидации пока нет готовых пакетов.
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {queueItems.map((item) => {
              const key = `${item.project_id}:${item.task_batch_id}`;
              const isSelected = selectedBatchKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedBatchKey(key)}
                  className={`w-full rounded-lg border p-4 text-left transition ${
                    isSelected
                      ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30"
                      : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-950"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{item.project_title}</div>
                      <div className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">Пакет #{item.batch_number}</div>
                    </div>
                    <span className="badge badge-warning">{item.frames_total} кадров</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
                    <span>✅ Принято: {item.approved_frames}</span>
                    <span>🔄 На доработку: {item.needs_changes_frames}</span>
                    <span>⚠️ Флаги QC: {item.flagged_frames}</span>
                    <span>📊 Среднее согласие: {item.average_agreement.toFixed(2)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Правая колонка: детали выбранного пакета */}
      <div className="card space-y-4">
        {!selectedQueueItem || !batchDetailQuery.data ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">Выберите пакет из очереди, чтобы открыть кадры и принять решение по каждому из них.</div>
        ) : (
          <>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{batchDetailQuery.data.project_title}</div>
              <h2 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">Валидация пакета #{batchDetailQuery.data.batch_number}</h2>
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Кадров в пакете: {batchDetailQuery.data.frames_total}</div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              {batchDetailQuery.data.items.map((item, index) => {
                const state = decisions[item.work_item_id] ?? { decision: "approve" as const, comment: "" };
                const flagged = Boolean(item.video_qc?.flag_for_review);
                return (
                  <div key={item.work_item_id} className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-gray-900 dark:text-white">Кадр {index + 1} / {batchDetailQuery.data.items.length}</div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          №{item.frame_number} | bbox: {item.final_box_count ?? 0} | согласие: {Number(item.agreement_score ?? 0).toFixed(2)}
                        </div>
                      </div>
                      {flagged ? <span className="badge badge-warning">⚠️ QC флаг</span> : <span className="badge badge-success">✅ OK</span>}
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[220px,1fr]">
                      {/* Превью кадра с рамками */}
                      <div className="relative h-40 w-full overflow-hidden rounded-lg border border-gray-200 bg-black dark:border-gray-800">
                        <img src={item.frame_url} alt={`Кадр ${item.frame_number}`} className="h-full w-full object-contain" />
                        {(item.final_annotation?.boxes ?? []).map((box, boxIndex) => (
                          <div
                            key={`${item.work_item_id}-${boxIndex}`}
                            className="absolute border-2 border-emerald-400"
                            style={{
                              left: `${(box.x / Math.max(item.width, 1)) * 100}%`,
                              top: `${(box.y / Math.max(item.height, 1)) * 100}%`,
                              width: `${(box.width / Math.max(item.width, 1)) * 100}%`,
                              height: `${(box.height / Math.max(item.height, 1)) * 100}%`,
                            }}
                          />
                        ))}
                      </div>

                      {/* Панель управления */}
                      <div className="space-y-3">
                        <div className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-800 dark:bg-gray-900">
                          <div className="font-medium text-gray-900 dark:text-white">📐 Результат разметки</div>
                          <pre className="mt-2 max-h-32 overflow-auto text-[11px] text-gray-700 dark:text-gray-300">
                            {JSON.stringify(item.final_annotation ?? { boxes: [] }, null, 2)}
                          </pre>
                        </div>

                        {flagged && (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            🔍 Межкадровая проверка обнаружила подозрительное расхождение. Такой кадр удобно отправлять на доработку.
                          </div>
                        )}

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px,1fr]">
                          <select
                            className="input-field"
                            value={state.decision}
                            onChange={(event) =>
                              setDecisions((current) => ({
                                ...current,
                                [item.work_item_id]: { ...state, decision: event.target.value as "approve" | "needs_changes" },
                              }))
                            }
                          >
                            <option value="approve">✅ Принять</option>
                            <option value="needs_changes">🔄 На доработку</option>
                          </select>
                          <input
                            className="input-field"
                            value={state.comment}
                            onChange={(event) =>
                              setDecisions((current) => ({
                                ...current,
                                [item.work_item_id]: { ...state, comment: event.target.value },
                              }))
                            }
                            placeholder="Комментарий по кадру (необязательно)"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div>
              <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">💬 Комментарий к пакету</div>
              <textarea className="input-field min-h-[110px]" value={batchComment} onChange={(event) => setBatchComment(event.target.value)} placeholder="Общий комментарий ко всем кадрам пакета (необязательно)" />
            </div>

            <button className="btn-primary" type="button" onClick={() => resolveMutation.mutate()} disabled={resolveMutation.isPending}>
              {resolveMutation.isPending ? "💾 Сохраняем..." : "✅ Сохранить решения по пакету"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
