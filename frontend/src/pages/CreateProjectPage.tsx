import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { participantsAPI, projectsAPI } from "../services/api";
import { Participant, ProjectLabel, ProjectTaskType, ProjectWidgetType, TaskTypeSpec } from "../types";

const LABEL_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2"];
const STEPS = ["Тип задачи", "Данные", "Метки", "Команда", "Качество"];

function parseLabels(raw: string): ProjectLabel[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name, index) => ({ name, color: LABEL_COLORS[index % LABEL_COLORS.length] }));
}

function widgetLabel(widget: string) {
  const labels: Record<string, string> = {
    video_intervals: "Интервалы видео",
    interval_validation: "Проверка интервалов",
    bbox: "Bounding box",
    bbox_validation: "Проверка bbox",
    text: "Текстовый ответ",
    image_labels: "Метки изображений",
    classification: "Классификация",
    comparison: "Сравнение",
  };
  return labels[widget] || widget.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inputModeLabel(mode: string) {
  const labels: Record<string, string> = {
    video_upload: "загрузка видео",
    image_upload: "загрузка изображений",
    video_frames: "кадры видео",
    source_project: "проект-источник",
    manual_items: "ручной список",
    csv: "CSV",
  };
  return labels[mode] || mode.replace(/_/g, " ");
}

function taskTypeTitle(spec?: TaskTypeSpec) {
  if (!spec) return "Проект разметки";
  const titles: Record<string, string> = {
    video_annotation: "Интервалы видео",
    video_interval_validation: "Проверка интервалов",
    bbox_annotation: "Bounding box",
    bbox_validation: "Проверка bbox",
    text_annotation: "Текстовая разметка",
    image_annotation: "Метки изображений",
    classification: "Классификация",
    comparison: "Сравнение",
  };
  return titles[spec.value] || spec.title;
}

function taskTypeDescription(spec?: TaskTypeSpec) {
  if (!spec) return "";
  const descriptions: Record<string, string> = {
    video_annotation: "Исполнители отмечают на видео интервалы, где есть нужный объект или событие.",
    video_interval_validation: "Независимая проверка интервалов из другого video-проекта.",
    bbox_annotation: "Исполнители рисуют прямоугольные рамки на изображениях или кадрах видео.",
    bbox_validation: "Проверка готовых bbox-разметок из проекта-источника.",
    text_annotation: "Свободный текстовый ответ по каждому заданию.",
    image_annotation: "Выбор метки для изображения без рисования рамок.",
    classification: "Выбор одного класса из схемы проекта.",
    comparison: "Выбор лучшего варианта из пары A/B.",
  };
  return descriptions[spec.value] || spec.description;
}

function qualityLabel(strategy?: string) {
  const labels: Record<string, string> = {
    interval_consensus: "согласование интервалов",
    majority_quorum: "решение большинством",
    bbox_iou_consensus_golden: "IoU-consensus и контрольные кадры",
    bbox_validation_golden: "проверка с контрольными кадрами",
    multi_annotator_review: "несколько исполнителей и ревью",
    label_consensus: "согласование меток",
    classification_consensus: "согласование классов",
    preference_consensus: "согласование предпочтений",
  };
  return labels[String(strategy || "")] || "контроль качества";
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

export default function CreateProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [taskType, setTaskType] = useState<ProjectTaskType>("bbox_annotation");
  const [widgetType, setWidgetType] = useState<ProjectWidgetType>("bbox");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
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
  const [participantSearch, setParticipantSearch] = useState("");
  const [participantSpecializationFilter, setParticipantSpecializationFilter] = useState("");
  const [participantGroupFilter, setParticipantGroupFilter] = useState("");
  const [participantImportFile, setParticipantImportFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const annotatorsQuery = useQuery({
    queryKey: ["participants", "annotator", participantSearch, participantSpecializationFilter, participantGroupFilter],
    queryFn: () => participantsAPI.list({
      role: "annotator",
      search: participantSearch || undefined,
      specialization: participantSpecializationFilter || undefined,
      group: participantGroupFilter || undefined,
      limit: 500,
    }),
  });
  const sourceProjectsQuery = useQuery({ queryKey: ["projects", "source-options", taskType], queryFn: () => projectsAPI.sourceOptions(taskType) });
  const registryQuery = useQuery({ queryKey: ["projects", "task-registry"], queryFn: () => projectsAPI.taskRegistry() });

  const taskSpecs = registryQuery.data?.task_types ?? [];
  const taskConfig = taskSpecs.find((item) => item.value === taskType) as TaskTypeSpec | undefined;
  const needsLabels = Boolean(taskConfig?.ui_hints?.needs_labels);
  const needsSource = Boolean(taskConfig?.requires_source_project);
  const labelsPreview = useMemo(() => parseLabels(labelsInput), [labelsInput]);
  const sourceProjects = sourceProjectsQuery.data?.items ?? [];
  const filteredSourceProjects = useMemo(() => {
    const needle = sourceSearch.trim().toLowerCase();
    if (!needle) return sourceProjects;
    return sourceProjects.filter((project) => {
      const haystack = `${project.title} ${project.task_type} ${project.status} ${project.ready_count}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [sourceProjects, sourceSearch]);
  const selectedSourceProject = sourceProjects.find((project) => project.id === sourceProjectId);
  const canUseSourceProject = needsSource || sourceProjects.length > 0 || Boolean(taskConfig?.source_task_types?.length);
  const annotators = annotatorsQuery.data?.items ?? [];
  const specializationOptions = useMemo(
    () => Array.from(new Set(annotators.map((item) => item.specialization || "").filter(Boolean))).sort(),
    [annotators],
  );
  const groupOptions = useMemo(
    () => Array.from(new Set(annotators.flatMap((item) => [...(item.groups || []), item.group_name || ""]).filter(Boolean))).sort(),
    [annotators],
  );

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
    const nextSpec = taskSpecs.find((item) => item.value === next);
    setTaskType(next);
    setWidgetType(nextSpec?.default_widget ?? "bbox");
    setSourceProjectId("");
    setSourceSearch("");
  };

  const toggleAnnotator = (id: string) => {
    setSelectedAnnotators((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const selectFilteredAnnotators = () => {
    setSelectedAnnotators((current) => Array.from(new Set([...current, ...annotators.map((item) => item.id)])));
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const canSubmit = Boolean(taskConfig && title && (!needsLabels || labelsPreview.length > 0) && (!needsSource || sourceProjectId));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!taskConfig) {
        setError("Реестр типов задач ещё загружается.");
      return;
    }
    if (needsSource && !sourceProjectId) {
        setError("Выберите проект-источник перед созданием проекта проверки.");
      setStep(1);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const project = await projectsAPI.create({
        title,
        description,
        status: "active",
        task_type: taskType,
        widget_type: widgetType,
        source_project_id: sourceProjectId || null,
        source_config: {
          use_final_annotation: true,
          interval_statuses: taskType === "bbox_annotation" ? ["approved"] : ["draft", "approved"],
          materializer: taskConfig.materializer,
        },
        instructions,
        label_schema: needsLabels ? labelsPreview : [],
        participant_rules: {
          specialization,
          group: groupRule,
          assignment_scope: selectedAnnotators.length ? "selected_only" : "all",
          quality_strategy: taskConfig.quality_strategy,
        },
        allowed_annotator_ids: selectedAnnotators,
        allowed_reviewer_ids: [],
        frame_interval_sec: Number(frameInterval) || 1,
        assignments_per_task: Number(assignmentsPerTask) || 1,
        agreement_threshold: Number(agreementThreshold) || 0.75,
        iou_threshold: 0.5,
      });
      if (participantImportFile) {
        const credentials = await projectsAPI.importParticipantsCsv(project.id, participantImportFile);
        downloadBlob(credentials, `project-${project.id}-participant-credentials.csv`);
      }
      navigate(`/projects/${project.id}`);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.response?.data?.source_project_id || err.response?.data?.widget_type || err.response?.data?.error || "Не удалось создать проект");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Создать проект разметки</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Выберите задачу заказчика. Платформа сама подберёт виджет, входные данные, контроль качества и форматы экспорта.</p>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setStep(index)}
            className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
              step === index ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-200" : "border-gray-200 bg-white text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300"
            }`}
          >
            {index + 1}. {label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {step === 0 ? (
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
                    <div className="font-semibold text-gray-900 dark:text-white">{taskTypeTitle(spec)}</div>
                    <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{taskTypeDescription(spec)}</div>
                    <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                      Вход: {spec.input_modes.map(inputModeLabel).join(", ") || "по настройкам проекта"}
                    </div>
                  </button>
                );
              })}
              {registryQuery.isLoading ? <div className="text-sm text-gray-500 dark:text-gray-400">Загружаем типы задач...</div> : null}
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr,0.75fr]">
            <div className="card space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Название проекта</label>
                <input className="input-field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={taskTypeTitle(taskConfig)} required />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Описание</label>
                <textarea className="input-field min-h-[96px]" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Что нужно разметить и какой результат ожидается?" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Инструкция исполнителям</label>
                <textarea className="input-field min-h-[160px]" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Правила, примеры и критерии приемки..." />
              </div>
            </div>

            <div className="card space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Рабочий виджет</label>
                <select className="input-field" value={widgetType} onChange={(event) => setWidgetType(event.target.value as ProjectWidgetType)}>
                  {(taskConfig?.widgets ?? []).map((widget) => (
                    <option key={widget} value={widget}>
                      {widgetLabel(widget)}
                    </option>
                  ))}
                </select>
              </div>

              {canUseSourceProject ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Проект-источник</label>
                  <select className="sr-only" value={sourceProjectId} onChange={(event) => setSourceProjectId(event.target.value)} required={needsSource} tabIndex={-1}>
                    <option value="">{needsSource ? "Выберите проект-источник" : "Без проекта-источника"}</option>
                    {sourceProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title} ({project.task_type}, готово: {project.ready_count})
                      </option>
                    ))}
                  </select>
                  <div className="space-y-3">
                    <input
                      className="input-field"
                      value={sourceSearch}
                      onChange={(event) => setSourceSearch(event.target.value)}
                      placeholder="Поиск по названию, типу или статусу"
                    />
                    <div className="max-h-72 space-y-2 overflow-auto rounded-lg border border-gray-200 p-2 dark:border-gray-800">
                      {!needsSource ? (
                        <button
                          type="button"
                          className={`w-full rounded-lg border p-3 text-left text-sm transition ${!sourceProjectId ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                          onClick={() => setSourceProjectId("")}
                        >
                          <div className="font-medium text-gray-900 dark:text-white">Без проекта-источника</div>
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Данные будут добавлены после создания проекта.</div>
                        </button>
                      ) : null}
                      {filteredSourceProjects.map((project) => {
                        const active = sourceProjectId === project.id;
                        return (
                          <button
                            key={project.id}
                            type="button"
                            className={`w-full rounded-lg border p-3 text-left text-sm transition ${active ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                            onClick={() => setSourceProjectId(project.id)}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate font-medium text-gray-900 dark:text-white">{project.title}</div>
                                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                  {project.task_type} · {project.status} · готово: {project.ready_count}
                                </div>
                              </div>
                              <span className={`rounded-full px-2 py-0.5 text-xs ${project.ready ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200" : "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-300"}`}>
                                {project.ready ? "Готов" : "Не готов"}
                              </span>
                            </div>
                            {formatDate(project.updated_at || project.created_at) ? <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Обновлен: {formatDate(project.updated_at || project.created_at)}</div> : null}
                          </button>
                        );
                      })}
                      {filteredSourceProjects.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
                          {sourceProjects.length ? "По этому запросу ничего не найдено." : "Совместимых проектов-источников пока нет."}
                        </div>
                      ) : null}
                    </div>
                    {selectedSourceProject ? (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
                        Выбран источник: {selectedSourceProject.title}
                        <button type="button" className="ml-2 font-medium underline" onClick={() => setSourceProjectId("")}>
                          сбросить
                        </button>
                      </div>
                    ) : needsSource ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                        Для этого типа проекта нужно выбрать совместимый источник.
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {sourceProjects.length
                      ? "Можно продолжить цепочку из результата предыдущего проекта. Sync создаст задания из готового результата источника."
                      : "Совместимых проектов-источников пока нет."}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                  Данные: {(taskConfig?.input_modes ?? []).map(inputModeLabel).join(", ") || "настраиваются после создания"}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="card space-y-4">
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
            ) : (
              <div className="text-sm text-gray-600 dark:text-gray-300">Для этого типа задачи схема меток не требуется.</div>
            )}
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
              Результат: {taskConfig?.export_formats?.map((item) => item.toUpperCase()).join(", ") || "JSON"}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="card space-y-5">
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
            <div>
              <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Пул исполнителей</div>
              <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950">
                <div className="text-sm font-medium text-gray-900 dark:text-white">Import participants from CSV</div>
                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">Columns: email, username or name, role, specialization, group or groups.</div>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="mt-3 block w-full text-sm text-gray-600 dark:text-gray-300"
                  onChange={(event) => setParticipantImportFile((event.target.files?.[0] as File | undefined) ?? null)}
                />
                {participantImportFile ? <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{participantImportFile.name}</div> : null}
              </div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Executor table</div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary" onClick={selectFilteredAnnotators}>Select filtered</button>
                  <button type="button" className="btn-secondary" onClick={() => setSelectedAnnotators([])}>Clear</button>
                </div>
              </div>
              <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <input className="input-field" value={participantSearch} onChange={(event) => setParticipantSearch(event.target.value)} placeholder="Search name or email" />
                <select className="input-field" value={participantSpecializationFilter} onChange={(event) => setParticipantSpecializationFilter(event.target.value)}>
                  <option value="">All specializations</option>
                  {specializationOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <select className="input-field" value={participantGroupFilter} onChange={(event) => setParticipantGroupFilter(event.target.value)}>
                  <option value="">All groups</option>
                  {groupOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
                <table className="table min-w-full text-sm">
                  <thead>
                    <tr>
                      <th className="py-2 pr-3 text-left">Select</th>
                      <th className="py-2 pr-3 text-left">User</th>
                      <th className="py-2 pr-3 text-left">Specialization</th>
                      <th className="py-2 pr-3 text-left">Groups</th>
                      <th className="py-2 pr-3 text-left">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {annotators.map((participant: Participant) => {
                      const active = selectedAnnotators.includes(participant.id);
                      const groups = [...(participant.groups || []), participant.group_name || ""].filter(Boolean);
                      return (
                        <tr key={participant.id} className="border-t border-gray-100 dark:border-gray-800">
                          <td className="py-2 pr-3"><input type="checkbox" checked={active} onChange={() => toggleAnnotator(participant.id)} /></td>
                          <td className="py-2 pr-3">
                            <div className="font-medium text-gray-900 dark:text-white">{participant.username}</div>
                            <div className="text-xs text-gray-500">{participant.email}</div>
                          </td>
                          <td className="py-2 pr-3">{participant.specialization || "-"}</td>
                          <td className="py-2 pr-3">{Array.from(new Set(groups)).join(", ") || "-"}</td>
                          <td className="py-2 pr-3">{participant.rating?.toFixed(2) ?? "0.00"}</td>
                        </tr>
                      );
                    })}
                    {annotators.length === 0 ? (
                      <tr><td className="py-4 text-gray-500" colSpan={5}>No executors found.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <div className="hidden">
                {(annotatorsQuery.data?.items ?? []).map((participant: Participant) => {
                  const active = selectedAnnotators.includes(participant.id);
                  return (
                    <button
                      key={participant.id}
                      type="button"
                      onClick={() => toggleAnnotator(participant.id)}
                      className={`rounded-lg border p-3 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                    >
                      <div className="font-medium text-gray-900 dark:text-white">{participant.username}</div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{participant.specialization || "Без специализации"} | рейтинг {participant.rating?.toFixed(2) ?? "0.00"}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="card space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Ответов на задание</label>
                <input type="number" min="1" step="1" className="input-field" value={assignmentsPerTask} onChange={(event) => setAssignmentsPerTask(event.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Порог согласия</label>
                <input type="number" step="0.05" min="0" max="1" className="input-field" value={agreementThreshold} onChange={(event) => setAgreementThreshold(event.target.value)} />
              </div>
              {taskConfig?.uses_cv_workflow ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Интервал кадров, сек</label>
                  <input type="number" step="0.1" min="0.1" className="input-field" value={frameInterval} onChange={(event) => setFrameInterval(event.target.value)} />
                </div>
              ) : null}
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
              Контроль качества: {qualityLabel(taskConfig?.quality_strategy)}
            </div>
          </div>
        ) : null}

        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{String(error)}</div> : null}

        <div className="flex flex-wrap justify-between gap-3">
          <button type="button" className="btn-secondary" onClick={() => (step === 0 ? navigate(-1) : setStep((current) => Math.max(0, current - 1)))}>
            {step === 0 ? "Отмена" : "Назад"}
          </button>
          <div className="flex gap-3">
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn-primary" onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}>
                Далее
              </button>
            ) : (
              <button type="submit" className="btn-primary" disabled={submitting || !canSubmit}>
                {submitting ? "Создаём..." : "Создать проект"}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
