import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { participantsAPI, projectsAPI } from "../services/api";
import { Participant, ProjectLabel, ProjectTaskType, ProjectWidgetType, TaskTypeSpec } from "../types";

const LABEL_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2"];

const WIDGET_TITLES: Record<ProjectWidgetType, string> = {
  video_intervals: "Интервалы видео",
  interval_validation: "Проверка интервалов",
  bbox: "Bounding boxes",
  bbox_validation: "Проверка bbox",
  text: "Текстовый ответ",
  image_labels: "Метки изображения",
  classification: "Классификация",
  comparison: "Сравнение",
};

function parseLabels(raw: string): ProjectLabel[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name, index) => ({
      name,
      color: LABEL_COLORS[index % LABEL_COLORS.length],
    }));
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
  const sourceProjects = (sourceProjectsQuery.data?.items ?? []).filter((project) => !sourceTaskType || project.task_type === sourceTaskType);

  useEffect(() => {
    if (!registryQuery.data) return;
    const defaultTask = registryQuery.data.default_task_type;
    const current = registryQuery.data.task_types.find((item) => item.value === taskType);
    if (!current) {
      setTaskType(defaultTask);
      setWidgetType(registryQuery.data.default_widget_type);
      return;
    }
    if (!current.widgets.includes(widgetType)) {
      setWidgetType(current.default_widget);
    }
  }, [registryQuery.data, taskType, widgetType]);

  const selectTaskType = (next: ProjectTaskType) => {
    setTaskType(next);
    const nextSpec = taskSpecs.find((item) => item.value === next);
    setWidgetType(nextSpec?.default_widget ?? "bbox");
    setSourceProjectId("");
  };

  const widgetLabel = (widget: ProjectWidgetType) => registryQuery.data?.widgets.find((item) => item.value === widget)?.title || WIDGET_TITLES[widget] || widget;

  const toggle = (id: string) => {
    setSelectedAnnotators((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!taskConfig) {
      setError("Registry is not loaded yet.");
      return;
    }
    if (needsSource && !sourceProjectId) {
      setError("Выберите проект-источник для валидации.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const project = await projectsAPI.create({
        title,
        description,
        status: "active",
        project_type: taskConfig.uses_cv_workflow ? "cv" : "standard",
        annotation_type: taskConfig.annotation_type,
        task_type: taskType,
        widget_type: widgetType,
        source_project_id: sourceProjectId || null,
        source_config: {
          use_final_annotation: true,
          interval_statuses: ["draft"],
        },
        instructions,
        label_schema: needsLabels ? labelsPreview : [],
        participant_rules: {
          specialization,
          group: groupRule,
          assignment_scope: "selected_only",
        },
        allowed_annotator_ids: selectedAnnotators,
        allowed_reviewer_ids: [],
        frame_interval_sec: Number(frameInterval) || 1,
        assignments_per_task: Number(assignmentsPerTask) || 1,
        agreement_threshold: Number(agreementThreshold) || 0.75,
        iou_threshold: 0.5,
      });
      navigate(`/projects/${project.id}`);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.response?.data?.source_project_id || err.response?.data?.widget_type || err.response?.data?.error || "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Создать проект разметки</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Типы заданий и виджеты загружаются из backend registry.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="card space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {taskSpecs.map((spec) => {
              const active = taskType === spec.value;
              return (
                <button
                  key={spec.value}
                  type="button"
                  onClick={() => selectTaskType(spec.value)}
                  className={`rounded-lg border p-4 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                >
                  <div className="font-semibold text-gray-900 dark:text-white">{spec.title}</div>
                  <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{spec.description}</div>
                </button>
              );
            })}
            {registryQuery.isLoading ? <div className="text-sm text-gray-500 dark:text-gray-400">Загружаем типы заданий...</div> : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr,0.75fr]">
          <div className="card space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Название проекта</label>
              <input className="input-field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={taskConfig?.title || "Project"} required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Описание</label>
              <textarea className="input-field min-h-[96px]" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Что нужно сделать и зачем нужен результат?" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Инструкция</label>
              <textarea className="input-field min-h-[160px]" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Опишите правила выполнения задания..." />
            </div>
          </div>

          <div className="card space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Виджет</label>
              <select className="input-field" value={widgetType} onChange={(event) => setWidgetType(event.target.value as ProjectWidgetType)}>
                {(taskConfig?.widgets ?? []).map((widget) => (
                  <option key={widget} value={widget}>
                    {widgetLabel(widget)}
                  </option>
                ))}
              </select>
            </div>

            {needsSource ? (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Проект-источник</label>
                <select className="input-field" value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} required>
                  <option value="">Выберите проект</option>
                  {sourceProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title} ({project.task_type})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {needsLabels ? (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Метки</label>
                <input className="input-field" value={labelsInput} onChange={(event) => setLabelsInput(event.target.value)} placeholder="car, person, road sign" />
                <div className="mt-2 flex flex-wrap gap-2">
                  {labelsPreview.map((label) => (
                    <span key={label.name} className="rounded-full px-3 py-1 text-xs font-medium text-white" style={{ backgroundColor: label.color }}>
                      {label.name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Ответов на задание</label>
                <input type="number" min="1" step="1" className="input-field" value={assignmentsPerTask} onChange={(event) => setAssignmentsPerTask(event.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Agreement threshold</label>
                <input type="number" step="0.05" min="0" max="1" className="input-field" value={agreementThreshold} onChange={(event) => setAgreementThreshold(event.target.value)} />
              </div>
            </div>

            {taskConfig?.uses_cv_workflow ? (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Интервал кадров, сек</label>
                <input type="number" step="0.1" min="0.1" className="input-field" value={frameInterval} onChange={(event) => setFrameInterval(event.target.value)} />
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Специализация</label>
                <input className="input-field" value={specialization} onChange={(event) => setSpecialization(event.target.value)} placeholder="computer vision" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Группа</label>
                <input className="input-field" value={groupRule} onChange={(event) => setGroupRule(event.target.value)} placeholder="group-42" />
              </div>
            </div>
          </div>
        </div>

        <div className="card space-y-5">
          <div>
            <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Пул исполнителей</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {(annotatorsQuery.data?.items ?? []).map((participant: Participant) => {
                const active = selectedAnnotators.includes(participant.id);
                return (
                  <button
                    key={participant.id}
                    type="button"
                    onClick={() => toggle(participant.id)}
                    className={`rounded-lg border p-3 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                  >
                    <div className="font-medium text-gray-900 dark:text-white">{participant.username}</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{participant.specialization || "Без специализации"} · rating {participant.rating?.toFixed(2) ?? "0.00"}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{String(error)}</div> : null}

        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={submitting || !taskConfig || !title || (needsLabels && labelsPreview.length === 0)}>
            {submitting ? "Создаем..." : "Создать проект"}
          </button>
        </div>
      </form>
    </div>
  );
}
