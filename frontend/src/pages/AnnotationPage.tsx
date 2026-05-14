import { useEffect, useMemo, useRef, useState } from "react";
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
  const [isDirty, setIsDirty] = useState(false);

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
    setBoxes(draftBoxes);
    setComment(assignmentQuery.data.comment ?? "");
    setSelectedLabel((assignmentQuery.data.label_schema?.[0]?.name as string | undefined) ?? "");
    setSelectedBoxIndex(draftBoxes.length > 0 ? 0 : null);
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
        } catch {
          navigate(`/labeling/projects/${assignmentQuery.data!.project_id}`);
        }
      }
    },
  });

  // ⌨️ Горячие клавиши: сохранение и отправка
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        submit(false);
        return;
      }

      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        submit(true);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [boxes, comment, selectedLabel]);

  // 🏷️ Выбор метки с холста
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

  // 💾 Автосохранение (каждые 30 секунд)
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
    setBoxes((current) => current.map((box, i) => (i === index ? { ...box, ...patch } : box)));
    setIsDirty(true);
  };

  const removeSelectedBox = () => {
    if (selectedBoxIndex === null) return;
    setBoxes((current) => current.filter((_, i) => i !== selectedBoxIndex));
    setSelectedBoxIndex((current) => {
      if (current === null || boxes.length <= 1) return null;
      return Math.max(0, current - 1);
    });
    setIsDirty(true);
  };

  const validateBeforeSubmit = (): string | null => {
    if (!assignmentQuery.data) return "Задание не загружено";
    const { width: fw, height: fh } = assignmentQuery.data.frame;
    if (boxes.length === 0) return "Добавьте хотя бы одну рамку.";
    for (const [i, box] of boxes.entries()) {
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height))
        return `Рамка №${i + 1}: координаты должны быть числами.`;
      if (box.width <= 0 || box.height <= 0) return `Рамка №${i + 1}: ширина и высота должны быть больше нуля.`;
      if (box.x < 0 || box.y < 0 || box.x + box.width > fw || box.y + box.height > fh)
        return `Рамка №${i + 1}: выходит за границы изображения.`;
      if (!allowedLabels.has(box.label)) return `Рамка №${i + 1}: недопустимая метка «${box.label}».`;
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
        <Link to="/labeling" className="btn-primary mt-4 inline-block">← К проектам</Link>
      </div>
    );
  }

  const frame = assignmentQuery.data.frame;
  const workflowMeta = assignmentQuery.data.workflow_meta;
  const batch = assignmentQuery.data.task_batch;

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {assignmentQuery.data.project_title}
          </div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">Разметка кадра</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Задание {assignmentQuery.data.assignment_id.slice(0, 8)} · кадр {frame.frame_number} · {frame.width}×{frame.height}
          </p>
          {workflowMeta?.task_batch_number && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Пакет {workflowMeta.task_batch_number}/{workflowMeta.task_batch_total} · кадр {workflowMeta.task_batch_index}/{workflowMeta.task_batch_size} в пакете · последовательность {workflowMeta.sequence_index}/{workflowMeta.sequence_length}
            </p>
          )}
          {isDirty && (
            <span className="mt-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              Несохранённые изменения
            </span>
          )}
        </div>
        <Link to="/labeling" className="btn-secondary">← К проектам</Link>
      </div>

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1.45fr),minmax(360px,0.8fr)]">
        {/* Основная область */}
        <section className="space-y-4">
          {/* Мини-статистика */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MiniStat label="Рамок" value={boxes.length} />
            <MiniStat label="Активная метка" value={selectedLabel || "—"} />
            <MiniStat label="Статус" value={assignmentQuery.data.status} />
            <MiniStat label="Размер кадра" value={`${frame.width}×${frame.height}`} />
          </div>

          {/* Холст */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            {workflowMeta?.task_batch_number && (
              <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
                Пакетная разметка: до {workflowMeta.task_batch_target_size || workflowMeta.task_batch_size || 10} кадров в задании, минимум {workflowMeta.min_sequence_size || 3} соседних кадра в последовательности.
              </div>
            )}

            {batch?.items?.length ? (
              <div className="mb-4 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">
                    Пакет {batch.batch_number}/{batch.total_batches}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Текущий кадр: {batch.current_index}/{batch.total} · ← → навигация
                  </div>
                </div>
                <div className="grid grid-cols-5 gap-2 lg:grid-cols-10">
                  {batch.items.map((item, index) => {
                    const isCurrent = item.assignment_id === assignmentQuery.data.assignment_id;
                    const tone =
                      item.assignment_status === "accepted" ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : item.assignment_status === "submitted" ? "border-amber-300 bg-amber-50 text-amber-700"
                      : item.assignment_status === "draft" || item.assignment_status === "in_progress" ? "border-blue-300 bg-blue-50 text-blue-700"
                      : "border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200";
                    return item.assignment_id ? (
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

        {/* Боковая панель */}
        <aside className="space-y-4">
          <Section title={`Метки · ${labels.length} шт.`}>
            <div className="flex flex-wrap gap-2">
              {labels.map((label, idx) => (
                <button
                  key={label.name}
                  type="button"
                  onClick={() => setSelectedLabel(label.name)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                    selectedLabel === label.name ? "text-white shadow-sm" : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200"
                  }`}
                  style={selectedLabel === label.name ? { backgroundColor: label.color || "#2563eb" } : undefined}
                >
                  {idx + 1}. {label.name}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              В режиме «Разметка» нарисуйте новую рамку на изображении. Готовую рамку можно выбрать и отредактировать.
            </p>
          </Section>

          <Section title="Выбранная рамка">
            <div className="flex items-center justify-between gap-3">
              <button type="button" className="btn-secondary" onClick={removeSelectedBox} disabled={selectedBoxIndex === null}>
                Удалить <span className="text-xs opacity-50">Del</span>
              </button>
            </div>
            {selectedBox ? (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Метка</label>
                  <select className="input-field" value={selectedBox.label} onChange={(e) => updateBox(selectedBoxIndex!, { label: e.target.value })}>
                    {labels.map((label) => <option key={label.name} value={label.name}>{label.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <CoordField label="X" value={selectedBox.x} onChange={(v) => updateBox(selectedBoxIndex!, { x: clampNumber(v, 0, frame.width - selectedBox.width, selectedBox.x) })} />
                  <CoordField label="Y" value={selectedBox.y} onChange={(v) => updateBox(selectedBoxIndex!, { y: clampNumber(v, 0, frame.height - selectedBox.height, selectedBox.y) })} />
                  <CoordField label="Ширина" value={selectedBox.width} onChange={(v) => updateBox(selectedBoxIndex!, { width: clampNumber(v, 1, frame.width - selectedBox.x, selectedBox.width) })} />
                  <CoordField label="Высота" value={selectedBox.height} onChange={(v) => updateBox(selectedBoxIndex!, { height: clampNumber(v, 1, frame.height - selectedBox.y, selectedBox.height) })} />
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                Выберите рамку на изображении, чтобы изменить её координаты или удалить.
              </div>
            )}
          </Section>

          <Section title="Инструкция">
            <div className="max-h-56 overflow-auto whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400">
              {assignmentQuery.data.instructions || "Инструкция для проекта пока не добавлена."}
            </div>
            {projectQuery.data?.instructions_file_uri && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-800 dark:bg-gray-900">
                📎 <a className="text-blue-600 hover:underline dark:text-blue-400" href={projectQuery.data.instructions_file_uri} target="_blank" rel="noreferrer">
                  {projectQuery.data.instructions_file_name || "Файл инструкции"}
                </a>
                <span className="ml-2 text-gray-500">v{projectQuery.data.instructions_version ?? 0}</span>
              </div>
            )}
          </Section>

          <Section title="Комментарий и отправка">
            <textarea className="input-field mt-3 min-h-[100px]" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Оставьте комментарий к кадру (необязательно)" />
            <div className="mt-3 space-y-2">
              {assignmentQuery.data.pre_annotations?.boxes?.length ? <InfoBox type="info">Для этого кадра есть AI-подсказки. Проверьте их перед отправкой.</InfoBox> : null}
              {assignmentQuery.data.quality_signals?.too_fast ? <InfoBox type="warning">Предыдущая отправка была отмечена как слишком быстрая.</InfoBox> : null}
              {workflowMeta?.validation_ready ? <InfoBox type="success">Кадр находится в последовательности, готовой для межкадровых проверок.</InfoBox> : null}
              {validationError ? <InfoBox type="error">{validationError}</InfoBox> : null}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" className="btn-secondary" onClick={() => submit(false)} disabled={submitMutation.isPending}>
                💾 Сохранить черновик <span className="text-xs opacity-50 ml-1">Ctrl+S</span>
              </button>
              <button type="button" className="btn-primary" onClick={() => submit(true)} disabled={submitMutation.isPending || boxes.length === 0}>
                ✅ Отправить <span className="text-xs opacity-50 ml-1">Enter</span>
              </button>
            </div>
          </Section>
        </aside>
      </div>
    </div>
  );
}

// 🧩 Вспомогательные компоненты
function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
      {children}
    </section>
  );
}

function CoordField({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}</label>
      <input type="number" className="input-field" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function InfoBox({ type, children }: { type: "info" | "warning" | "error" | "success"; children: React.ReactNode }) {
  const colors = {
    info: "border-blue-200 bg-blue-50 text-blue-700",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    error: "border-red-200 bg-red-50 text-red-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return <div className={`rounded-lg border p-3 text-xs ${colors[type]}`}>{children}</div>;
}
