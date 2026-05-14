import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { participantsAPI, projectsAPI } from "../services/api";
import { Participant, ProjectLabel, ProjectTaskType, ProjectWidgetType, TaskTypeSpec } from "../types";

const LABEL_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2"];

const WIDGET_TITLES: Record<ProjectWidgetType, string> = {
  video_intervals: "Интервалы видео",
  interval_validation: "Проверка интервалов",
  bbox: "Ограничивающие рамки",
  bbox_validation: "Проверка рамок",
  text: "Текстовый ответ",
  image_labels: "Метки изображения",
  classification: "Классификация",
  comparison: "Сравнение",
};

function parseLabels(raw: string): ProjectLabel[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((name, i) => ({ name, color: LABEL_COLORS[i % LABEL_COLORS.length] }));
}

export default function CreateProjectPage() {
  const navigate = useNavigate();
  const [taskType, setTaskType] = useState<ProjectTaskType>("bbox_annotation");
  const [widgetType, setWidgetType] = useState<ProjectWidgetType>("bbox");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [labelsInput, setLabelsInput] = useState("object");
  const [frameInterval, setFrameInterval] = useState("1");
  const [assignmentsPerTask, setAssignmentsPerTask] = useState("2");
  const [agreementThreshold, setAgreementThreshold] = useState("0.75");
  const [specialization, setSpecialization] = useState("");
  const [groupRule, setGroupRule] = useState("");
  const [selectedAnnotators, setSelectedAnnotators] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const annotatorsQuery = useQuery({ queryKey: ["participants", "annotator"], queryFn: () => participantsAPI.list("annotator") });
  const sourceProjectsQuery = useQuery({ queryKey: ["projects", "source-options"], queryFn: () => projectsAPI.list({ limit: 100 }) });
  const registryQuery = useQuery({ queryKey: ["projects", "task-registry"], queryFn: () => projectsAPI.taskRegistry() });

  const taskSpecs = registryQuery.data?.task_types ?? [];
  const taskConfig = taskSpecs.find((item) => item.value === taskType) as TaskTypeSpec | undefined;
  const needsLabels = Boolean(taskConfig?.ui_hints?.needs_labels);
  const needsSource = Boolean(taskConfig?.requires_source_project);
  const labelsPreview = useMemo(() => parseLabels(labelsInput), [labelsInput]);
  const sourceTaskType = String(taskConfig?.ui_hints?.source_task_type || "");
  const sourceProjects = (sourceProjectsQuery.data?.items ?? []).filter((p) => !sourceTaskType || p.task_type === sourceTaskType);

  useEffect(() => {
    if (!registryQuery.data) return;
    const current = registryQuery.data.task_types.find((item) => item.value === taskType);
    if (!current) {
      setTaskType(registryQuery.data.default_task_type);
      setWidgetType(registryQuery.data.default_widget_type);
      return;
    }
    if (!current.widgets.includes(widgetType)) setWidgetType(current.default_widget);
  }, [registryQuery.data, taskType, widgetType]);

  const selectTaskType = (next: ProjectTaskType) => {
    setTaskType(next);
    const spec = taskSpecs.find((item) => item.value === next);
    setWidgetType(spec?.default_widget ?? "bbox");
    setSourceProjectId("");
  };

  const widgetLabel = (w: ProjectWidgetType) => registryQuery.data?.widgets.find((item) => item.value === w)?.title || WIDGET_TITLES[w] || w;

  const toggleAnnotator = (id: string) => setSelectedAnnotators((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!taskConfig) { setError("Реестр типов ещё не загружен."); return; }
    if (needsSource && !sourceProjectId) { setError("Выберите проект-источник."); return; }
    setSubmitting(true); setError(null);
    try {
      const project = await projectsAPI.create({
        title, description, status: "active",
        project_type: taskConfig.uses_cv_workflow ? "cv" : "standard",
        annotation_type: taskConfig.annotation_type,
        task_type: taskType, widget_type: widgetType,
        source_project_id: sourceProjectId || null,
        source_config: { use_final_annotation: true, interval_statuses: ["draft"] },
        instructions,
        label_schema: needsLabels ? labelsPreview : [],
        participant_rules: { specialization, group: groupRule, assignment_scope: "selected_only" },
        allowed_annotator_ids: selectedAnnotators, allowed_reviewer_ids: [],
        frame_interval_sec: Number(frameInterval) || 1,
        assignments_per_task: Number(assignmentsPerTask) || 1,
        agreement_threshold: Number(agreementThreshold) || 0.75,
        iou_threshold: 0.5,
      });
      navigate(`/projects/${project.id}`);
    } catch (err: any) {
      setError(err.response?.data?.detail || "Не удалось создать проект");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">📋 Создать проект разметки</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Выберите тип задания, настройте метки и назначьте исполнителей.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Типы заданий */}
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">🎯 Тип задания</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {taskSpecs.map((spec) => {
              const active = taskType === spec.value;
              const titles: Record<string, string> = {
                video_annotation: "🎬 Разметка интервалов видео",
                video_interval_validation: "✅ Проверка интервалов",
                bbox_annotation: "📦 Разметка ограничивающими рамками",
                bbox_validation: "🔍 Проверка рамок",
                text_annotation: "📝 Текстовая разметка",
                image_annotation: "🖼️ Разметка изображений",
                classification: "🏷️ Классификация",
                comparison: "⚖️ Сравнение",
              };
              return (
                <button
                  key={spec.value}
                  type="button"
                  onClick={() => selectTaskType(spec.value)}
                  className={`rounded-lg border p-4 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                >
                  <div className="font-semibold text-gray-900 dark:text-white">{titles[spec.value] || spec.title}</div>
                  <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{spec.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr,0.75fr]">
          {/* Основные поля */}
          <div className="card space-y-4">
            <InputField label="📌 Название проекта" value={title} onChange={setTitle} placeholder={taskConfig?.title || "Проект"} required />
            <TextareaField label="📝 Описание" value={description} onChange={setDescription} placeholder="Что нужно сделать и зачем?" />
            <TextareaField label="📖 Инструкция" value={instructions} onChange={setInstructions} placeholder="Опишите правила выполнения задания..." rows={5} />
          </div>

          {/* Настройки */}
          <div className="card space-y-4">
            <SelectField label="🧩 Виджет" value={widgetType} onChange={(v) => setWidgetType(v as ProjectWidgetType)} options={(taskConfig?.widgets ?? []).map((w) => ({ value: w, label: widgetLabel(w) }))} />

            {needsSource && (
              <SelectField label="📁 Проект-источник" value={sourceProjectId} onChange={setSourceProjectId} required
                options={[{ value: "", label: "Выберите проект" }, ...sourceProjects.map((p) => ({ value: p.id, label: `${p.title} (${p.task_type})` }))]} />
            )}

            {needsLabels && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">🏷️ Метки (через запятую)</label>
                <input className="input-field" value={labelsInput} onChange={(e) => setLabelsInput(e.target.value)} placeholder="drone, bird, plane" />
                <div className="mt-2 flex flex-wrap gap-2">
                  {labelsPreview.map((label) => (
                    <span key={label.name} className="rounded-full px-3 py-1 text-xs font-medium text-white" style={{ backgroundColor: label.color }}>{label.name}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <InputField label="👥 Ответов на задание" type="number" value={assignmentsPerTask} onChange={setAssignmentsPerTask} />
              <InputField label="📊 Порог согласия" type="number" step="0.05" value={agreementThreshold} onChange={setAgreementThreshold} />
            </div>

            {taskConfig?.uses_cv_workflow && <InputField label="🎞️ Интервал кадров (сек)" type="number" step="0.1" value={frameInterval} onChange={setFrameInterval} />}

            <div className="grid grid-cols-2 gap-4">
              <InputField label="🔧 Специализация" value={specialization} onChange={setSpecialization} placeholder="computer vision" />
              <InputField label="👥 Группа" value={groupRule} onChange={setGroupRule} placeholder="group-42" />
            </div>
          </div>
        </div>

        {/* Пул исполнителей */}
        <div className="card">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">👥 Пул исполнителей</h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {(annotatorsQuery.data?.items ?? []).map((p: Participant) => {
              const active = selectedAnnotators.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleAnnotator(p.id)}
                  className={`rounded-lg border p-3 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                >
                  <div className="font-medium text-gray-900 dark:text-white">{p.username}</div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{p.specialization || "Без специализации"} · рейтинг {p.rating?.toFixed(2) ?? "0.00"}</div>
                </button>
              );
            })}
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">❌ {error}</div>}

        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>↩️ Отмена</button>
          <button type="submit" className="btn-primary" disabled={submitting || !taskConfig || !title}>
            {submitting ? "⏳ Создаём..." : "✅ Создать проект"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Вспомогательные компоненты
function InputField({ label, value, onChange, type = "text", placeholder, required, step }: any) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <input className="input-field" type={type} step={step} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} />
    </div>
  );
}

function TextareaField({ label, value, onChange, placeholder, rows = 3 }: any) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <textarea className="input-field" style={{ minHeight: `${rows * 32}px` }} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function SelectField({ label, value, onChange, options, required }: any) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <select className="input-field" value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        {options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
