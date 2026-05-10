import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AnnotationCanvas from "../components/AnnotationCanvas";
import { annotatorAPI, projectsAPI } from "../services/api";
import { BoundingBox } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";

function clampNumber(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export default function AnnotationPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [boxes, setBoxes] = useState<BoundingBox[]>([]);
  const [comment, setComment] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");
  const [selectedBoxIndex, setSelectedBoxIndex] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false); // unsaved changes indicator

  // Undo/Redo external triggers
  const canvasUndoRef = useRef<() => void>(() => {});
  const canvasRedoRef = useRef<() => void>(() => {});

  const assignmentQuery = useQuery({
    queryKey: ["annotator-assignment", assignmentId],
    queryFn: () => annotatorAPI.detail(assignmentId!),
    enabled: !!assignmentId,
  });

  const projectQuery = useQuery({
    queryKey: ["project", assignmentQuery.data?.project_id],
    queryFn: () => projectsAPI.get(assignmentQuery.data!.project_id),
    enabled: !!assignmentQuery.data?.project_id,
  });

  useEffect(() => {
    if (!assignmentQuery.data) return;
    const draftBoxes = assignmentQuery.data.draft?.boxes ?? [];
    const initialBoxes = draftBoxes;
    setBoxes(initialBoxes);
    setComment(assignmentQuery.data.comment ?? "");
    setSelectedLabel((assignmentQuery.data.label_schema?.[0]?.name as string | undefined) ?? "");
    setSelectedBoxIndex(initialBoxes.length > 0 ? 0 : null);
    setIsDirty(false);
  }, [assignmentQuery.data]);

  const labels = useMemo(() => assignmentQuery.data?.label_schema ?? [], [assignmentQuery.data]);
  const allowedLabels = useMemo(() => new Set(labels.map((label) => label.name)), [labels]);
  const selectedBox = selectedBoxIndex !== null ? boxes[selectedBoxIndex] ?? null : null;

  const submitMutation = useMutation({
    mutationFn: (isFinal: boolean) => annotatorAPI.submit(assignmentId!, { label_data: { boxes }, comment, is_final: isFinal }),
    onSuccess: async (result) => {
      setIsDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["annotator-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-project-detail", assignmentQuery.data?.project_id] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-assignment", assignmentId] });
      if (result.assignment_status === "submitted" || result.assignment_status === "accepted" || result.evaluation?.state === "requeued") {
        try {
          const next = await annotatorAPI.nextProjectAssignment(assignmentQuery.data!.project_id);
          navigate(`/labeling/assignments/${next.assignment_id}`);
          return;
        } catch {
          navigate(`/labeling/projects/${assignmentQuery.data!.project_id}`);
          return;
        }
      }
    },
  });

  // ============================================================
  // ⌨️ HOTKEYS — save, submit, navigate
  // ============================================================
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // Ctrl+S — save draft
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        submit(false);
        return;
      }

      // Enter — final submit
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        submit(true);
        return;
      }

      // Arrow keys — navigate batch
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        // This is handled by the batch item links — we just let the user click
        // But we can also trigger programmatic navigation if needed
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [boxes, comment, selectedLabel]);

  // ============================================================
  // Listen for custom events from AnnotationCanvas
  // ============================================================
  useEffect(() => {
    const onSelectLabel = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && labels.some((l) => l.name === detail)) {
        setSelectedLabel(detail);
      }
    };
    window.addEventListener("annotation:select-label", onSelectLabel);
    return () => window.removeEventListener("annotation:select-label", onSelectLabel);
  }, [labels]);

  // ============================================================
  // AUTO-SAVE (every 30 seconds)
  // ============================================================
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    autoSaveRef.current = setInterval(() => {
      submitMutation.mutate(false);
    }, 30000);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [isDirty, boxes, comment]);

  const updateBox = (index: number, patch: Partial<BoundingBox>) => {
    setBoxes((current) => current.map((box, boxIndex) => (boxIndex === index ? { ...box, ...patch } : box)));
    setIsDirty(true);
  };

  const removeSelectedBox = () => {
    if (selectedBoxIndex === null) return;
    setBoxes((current) => current.filter((_, index) => index !== selectedBoxIndex));
    setSelectedBoxIndex((current) => {
      if (current === null) return null;
      if (boxes.length <= 1) return null;
      return Math.max(0, current - 1);
    });
    setIsDirty(true);
  };

  const validateBeforeSubmit = (): string | null => {
    if (!assignmentQuery.data) return "Задание не загружено";
    const frameWidth = assignmentQuery.data.frame.width;
    const frameHeight = assignmentQuery.data.frame.height;
    if (boxes.length === 0) return "Добавьте хотя бы одну рамку.";
    for (const [index, box] of boxes.entries()) {
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height)) {
        return `Рамка #${index + 1}: координаты должны быть числами.`;
      }
      if (box.width <= 0 || box.height <= 0) return `Рамка #${index + 1}: ширина и высота должны быть больше нуля.`;
      if (box.x < 0 || box.y < 0 || box.x + box.width > frameWidth || box.y + box.height > frameHeight) {
        return `Рамка #${index + 1}: выходит за границы изображения.`;
      }
      if (!allowedLabels.has(box.label)) return `Рамка #${index + 1}: неизвестная метка "${box.label}".`;
    }
    return null;
  };

  const submit = (isFinal: boolean) => {
    const error = validateBeforeSubmit();
    setValidationError(error);
    if (error) return;
    submitMutation.mutate(isFinal);
  };

  if (assignmentQuery.isLoading) return <LoadingSpinner size="lg" />;

  if (!assignmentQuery.data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Задание не найдено</h1>
        <Link to="/labeling" className="btn-primary mt-4 inline-block">Назад</Link>
      </div>
    );
  }

  const frame = assignmentQuery.data.frame;
  const workflowMeta = assignmentQuery.data.workflow_meta;
  const batch = assignmentQuery.data.task_batch;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{assignmentQuery.data.project_title}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">Разметка кадра</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Задание {assignmentQuery.data.assignment_id.slice(0, 8)} | кадр {frame.frame_number} | {frame.width}x{frame.height}
          </p>
          {workflowMeta?.task_batch_number ? (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Пакет {workflowMeta.task_batch_number}/{workflowMeta.task_batch_total} | кадр {workflowMeta.task_batch_index}/{workflowMeta.task_batch_size} в пакете | последовательность {workflowMeta.sequence_index}/{workflowMeta.sequence_length}
            </p>
          ) : null}
          {isDirty && (
            <span className="inline-block mt-2 px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded">Несохранённые изменения</span>
          )}
        </div>
        <Link to="/labeling" className="btn-secondary">К проектам</Link>
      </div>

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1.45fr),minmax(360px,0.8fr)]">
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
              <div className="text-xs text-gray-500 dark:text-gray-400">Рамок</div>
              <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{boxes.length}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
              <div className="text-xs text-gray-500 dark:text-gray-400">Активная метка</div>
              <div className="mt-1 truncate text-base font-semibold text-gray-900 dark:text-white">{selectedLabel || "Не выбрана"}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
              <div className="text-xs text-gray-500 dark:text-gray-400">Статус</div>
              <div className="mt-1 text-base font-semibold text-gray-900 dark:text-white">{assignmentQuery.data.status}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
              <div className="text-xs text-gray-500 dark:text-gray-400">Размер кадра</div>
              <div className="mt-1 text-base font-semibold text-gray-900 dark:text-white">{frame.width}x{frame.height}</div>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            {workflowMeta?.task_batch_number ? (
              <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
                Пакетная логика активна: до {workflowMeta.task_batch_target_size || workflowMeta.task_batch_size || 10} кадров в задании и минимум {workflowMeta.min_sequence_size || 3} соседних кадров в последовательности.
              </div>
            ) : null}
            {batch?.items?.length ? (
              <div className="mb-4 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">
                    Кадры в пакете {batch.batch_number}/{batch.total_batches}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Текущий кадр: {batch.current_index}/{batch.total} | ← → стрелки
                  </div>
                </div>
                <div className="grid grid-cols-5 gap-2 lg:grid-cols-10">
                  {batch.items.map((item, index) => {
                    const isCurrent = item.assignment_id === assignmentQuery.data.assignment_id;
                    const isOpenable = Boolean(item.assignment_id);
                    const tone =
                      item.assignment_status === "accepted"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : item.assignment_status === "submitted"
                          ? "border-amber-300 bg-amber-50 text-amber-700"
                          : item.assignment_status === "draft" || item.assignment_status === "in_progress"
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : "border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200";
                    return isOpenable ? (
                      <Link
                        key={item.work_item_id}
                        to={`/labeling/assignments/${item.assignment_id}`}
                        className={`rounded-lg border px-2 py-2 text-center text-xs font-medium transition ${tone} ${isCurrent ? "ring-2 ring-indigo-400" : ""}`}
                      >
                        {index + 1}
                      </Link>
                    ) : (
                      <div key={item.work_item_id} className={`rounded-lg border px-2 py-2 text-center text-xs font-medium opacity-70 ${tone}`}>
                        {index + 1}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <AnnotationCanvas
              imageUrl={assignmentQuery.data.frame_url}
              value={boxes}
              labels={labels}
              currentLabel={selectedLabel}
              selectedBoxIndex={selectedBoxIndex}
              onSelectedBoxIndexChange={setSelectedBoxIndex}
              onBoxesChange={(newBoxes) => { setBoxes(newBoxes); setIsDirty(true); }}
            />
          </div>
        </section>

        <aside className="space-y-4">
          {/* Labels */}
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Метки</h2>
              <div className="text-xs text-gray-500 dark:text-gray-400">{labels.length} шт.</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {labels.map((label, idx) => (
                <button
                  key={label.name}
                  type="button"
                  onClick={() => setSelectedLabel(label.name)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${selectedLabel === label.name ? "text-white shadow-sm" : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200"}`}
                  style={selectedLabel === label.name ? { backgroundColor: label.color || "#2563eb" } : undefined}
                >
                  {idx + 1}. {label.name}
                </button>
              ))}
            </div>
            <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              В режиме разметки нарисуйте новую рамку на изображении. Готовую рамку можно выбрать и подправить вручную.
            </div>
          </section>

          {/* Selected Box Editor */}
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Выбранная рамка</h2>
              <button type="button" className="btn-secondary" onClick={removeSelectedBox} disabled={selectedBoxIndex === null}>
                Удалить <span className="text-xs opacity-50">Del</span>
              </button>
            </div>
            {selectedBox ? (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Метка</label>
                  <select className="input-field" value={selectedBox.label} onChange={(event) => updateBox(selectedBoxIndex!, { label: event.target.value })}>
                    {labels.map((label) => (
                      <option key={label.name} value={label.name}>{label.name}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">X</label>
                    <input type="number" className="input-field" value={selectedBox.x}
                      onChange={(event) => updateBox(selectedBoxIndex!, { x: clampNumber(event.target.value, 0, frame.width - selectedBox.width, selectedBox.x) })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Y</label>
                    <input type="number" className="input-field" value={selectedBox.y}
                      onChange={(event) => updateBox(selectedBoxIndex!, { y: clampNumber(event.target.value, 0, frame.height - selectedBox.height, selectedBox.y) })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Ширина</label>
                    <input type="number" className="input-field" value={selectedBox.width}
                      onChange={(event) => updateBox(selectedBoxIndex!, { width: clampNumber(event.target.value, 1, frame.width - selectedBox.x, selectedBox.width) })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Высота</label>
                    <input type="number" className="input-field" value={selectedBox.height}
                      onChange={(event) => updateBox(selectedBoxIndex!, { height: clampNumber(event.target.value, 1, frame.height - selectedBox.y, selectedBox.height) })} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                Выберите рамку на изображении, чтобы изменить координаты или удалить ее.
              </div>
            )}
          </section>

          {/* Instructions */}
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Инструкция</h2>
            <div className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400">
              {assignmentQuery.data.instructions || "Инструкция для проекта пока не добавлена."}
            </div>
            {projectQuery.data?.instructions_file_uri ? (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                <div>
                  Файл инструкции:{" "}
                  <a className="text-blue-600 hover:underline dark:text-blue-400" href={projectQuery.data.instructions_file_uri} target="_blank" rel="noreferrer">
                    {projectQuery.data.instructions_file_name || "инструкция"}
                  </a>
                </div>
                <div className="mt-1 text-gray-500 dark:text-gray-400">
                  v{projectQuery.data.instructions_version ?? 0}
                  {projectQuery.data.instructions_updated_at ? ` | ${new Date(projectQuery.data.instructions_updated_at).toLocaleString()}` : ""}
                </div>
              </div>
            ) : null}
          </section>

          {/* Submit */}
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Комментарий и отправка</h2>
            <textarea className="input-field mt-3 min-h-[120px]" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="При необходимости оставьте комментарий по кадру" />
            <div className="mt-3 space-y-2">
              {assignmentQuery.data.pre_annotations?.boxes?.length ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700">Для этого кадра есть AI-подсказки. Проверьте их перед финальной отправкой.</div>
              ) : null}
              {assignmentQuery.data.quality_signals?.too_fast ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Предыдущая отправка по этому заданию была отмечена как слишком быстрая.</div>
              ) : null}
              {workflowMeta?.validation_ready ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">Этот кадр находится в последовательности, готовой для дальнейших межкадровых проверок.</div>
              ) : null}
              {validationError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{validationError}</div>
              ) : null}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" className="btn-secondary" onClick={() => submit(false)} disabled={submitMutation.isPending}>
                💾 Сохранить черновик <span className="text-xs opacity-50 ml-1">Ctrl+S</span>
              </button>
              <button type="button" className="btn-primary" onClick={() => submit(true)} disabled={submitMutation.isPending || boxes.length === 0}>
                ✅ Отправить и далее <span className="text-xs opacity-50 ml-1">Enter</span>
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
