import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { participantsAPI, projectsAPI, workflowAPI } from "../services/api";
import { Participant, Project, ProjectLabel, ProjectParticipantRules, Role } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

const DEFAULT_LABEL_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04", "#4f46e5"];
const TRACKING_ALGORITHMS = ["CSRT", "KCF", "MOSSE", "MIL", "MedianFlow", "TLD", "BOOSTING"] as const;

function splitLines(raw: string): string[] {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

function joinLines(lines?: string[]): string {
  return (lines ?? []).join("\n");
}

function getDefaultLabelColor(index: number): string {
  return DEFAULT_LABEL_COLORS[index % DEFAULT_LABEL_COLORS.length];
}

function ensureUniqueLabelNames(labels: ProjectLabel[]): { ok: boolean; error?: string } {
  const seen = new Set<string>();
  for (const label of labels) {
    const key = (label.name || "").trim().toLowerCase();
    if (!key) return { ok: false, error: "Название метки не может быть пустым." };
    if (seen.has(key)) return { ok: false, error: `Метка с именем "${label.name}" уже существует` };
    seen.add(key);
  }
  return { ok: true };
}

function normalizeParticipantRules(rules?: ProjectParticipantRules): Required<ProjectParticipantRules> {
  return {
    specialization: String(rules?.specialization ?? ""),
    group: String(rules?.group ?? ""),
    assignment_scope: (rules?.assignment_scope as Required<ProjectParticipantRules>["assignment_scope"]) ?? "selected_only",
    stage_pools: rules?.stage_pools ?? {},
    ai_prelabel_enabled: Boolean(rules?.ai_prelabel_enabled ?? true),
    ai_model: String(rules?.ai_model ?? "baseline-box-v1"),
    ai_confidence_threshold: Number(rules?.ai_confidence_threshold ?? 0.7),
    video_keyframe_interval: Number(rules?.video_keyframe_interval ?? 1),
    tracking_algorithm: String(rules?.tracking_algorithm ?? "CSRT"),
    task_batch_size: Number(rules?.task_batch_size ?? 10),
    min_sequence_size: Number(rules?.min_sequence_size ?? 3),
    interval_annotators_per_chunk: Number(rules?.interval_annotators_per_chunk ?? 1),
    interval_validators_per_item: Number(rules?.interval_validators_per_item ?? 3),
    bbox_validators_per_batch: Number(rules?.bbox_validators_per_batch ?? 3),
    bbox_real_items_per_batch: Number(rules?.bbox_real_items_per_batch ?? 20),
    bbox_golden_items_per_batch: Number(rules?.bbox_golden_items_per_batch ?? 10),
    golden_min_score: Number(rules?.golden_min_score ?? 0.8),
    golden_candidate_threshold: Number(rules?.golden_candidate_threshold ?? 0.9),
    golden_promotion_target: Number(rules?.golden_promotion_target ?? 10),
    annotation_golden_interval: Number(rules?.annotation_golden_interval ?? 9),
    interval_review_padding_sec: Number(rules?.interval_review_padding_sec ?? 3),
    stuck_assignment_ttl_minutes: Number(rules?.stuck_assignment_ttl_minutes ?? 30),
  };
}

function canEditProject(role?: Role): boolean {
  return role === "customer" || role === "admin";
}

function ParticipantSelector({
  title,
  hint,
  items,
  selected,
  onToggle,
}: {
  title: string;
  hint?: string;
  items: Participant[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">{title}</div>
      {hint && <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</div>}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {items.map((participant) => {
          const active = selected.includes(participant.id);
          return (
            <button
              key={participant.id}
              type="button"
              onClick={() => onToggle(participant.id)}
              className={`rounded-lg border p-3 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-950"}`}
            >
              <div className="font-medium text-gray-900 dark:text-white">{participant.username}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {participant.specialization || "Без специализации"} | рейтинг {participant.rating?.toFixed(2) ?? "0.00"}
              </div>
              {participant.group_name && <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">группа: {participant.group_name}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ProjectWorkflowPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [annotationType, setAnnotationType] = useState<Project["annotation_type"]>("bbox");
  const [frameInterval, setFrameInterval] = useState("1");
  const [assignmentsPerTask, setAssignmentsPerTask] = useState("2");
  const [agreementThreshold, setAgreementThreshold] = useState("0.75");
  const [iouThreshold, setIouThreshold] = useState("0.5");
  const [specialization, setSpecialization] = useState("");
  const [groupRule, setGroupRule] = useState("");
  const [assignmentScope, setAssignmentScope] = useState<Required<ProjectParticipantRules>["assignment_scope"]>("selected_only");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiModel, setAiModel] = useState("baseline-box-v1");
  const [aiConfidenceThreshold, setAiConfidenceThreshold] = useState("0.7");
  const [videoKeyframeInterval, setVideoKeyframeInterval] = useState("1");
  const [trackingAlgorithm, setTrackingAlgorithm] = useState<(typeof TRACKING_ALGORITHMS)[number]>("CSRT");
  const [taskBatchSize, setTaskBatchSize] = useState("10");
  const [minSequenceSize, setMinSequenceSize] = useState("3");
  const [labels, setLabels] = useState<ProjectLabel[]>([{ name: "drone", color: getDefaultLabelColor(0) }]);
  const [selectedAnnotators, setSelectedAnnotators] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [participantsCsv, setParticipantsCsv] = useState<File | null>(null);
  const [distributionResult, setDistributionResult] = useState("");

  const projectQuery = useQuery({ queryKey: ["project", projectId], queryFn: () => projectsAPI.get(projectId!), enabled: !!projectId });
  const overviewQuery = useQuery({ queryKey: ["project-overview", projectId], queryFn: () => workflowAPI.overview(projectId!), enabled: !!projectId });
  const annotatorsQuery = useQuery({ queryKey: ["participants", "annotator"], queryFn: () => participantsAPI.list("annotator") });

  useEffect(() => {
    if (!projectQuery.data) return;
    const project = projectQuery.data;
    const rules = normalizeParticipantRules(project.participant_rules);
    setAnnotationType(project.annotation_type);
    setFrameInterval(String(project.frame_interval_sec ?? 1));
    setAssignmentsPerTask(String(project.assignments_per_task ?? 2));
    setAgreementThreshold(String(project.agreement_threshold ?? 0.75));
    setIouThreshold(String(project.iou_threshold ?? 0.5));
    setSpecialization(rules.specialization);
    setGroupRule(rules.group);
    setAssignmentScope(rules.assignment_scope);
    setAiEnabled(rules.ai_prelabel_enabled);
    setAiModel(rules.ai_model);
    setAiConfidenceThreshold(String(rules.ai_confidence_threshold));
    setVideoKeyframeInterval(String(rules.video_keyframe_interval));
    setTaskBatchSize(String(rules.task_batch_size));
    setMinSequenceSize(String(rules.min_sequence_size));
    setTrackingAlgorithm(TRACKING_ALGORITHMS.includes(rules.tracking_algorithm as any) ? rules.tracking_algorithm as any : "CSRT");
    setLabels((project.label_schema?.length ? project.label_schema : [{ name: "drone", color: getDefaultLabelColor(0) }]).map((label, index) => ({
      ...label,
      color: label.color || getDefaultLabelColor(index),
    })));
    setSelectedAnnotators(project.allowed_annotator_ids ?? []);
  }, [projectQuery.data]);

  const hasWorkItems = useMemo(() => Number(overviewQuery.data?.work_items?.total ?? 0) > 0, [overviewQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("ID проекта отсутствует");
      const uniqueCheck = ensureUniqueLabelNames(labels);
      if (!uniqueCheck.ok) throw new Error(uniqueCheck.error || "Неверная схема меток");
      return projectsAPI.update(projectId, {
        annotation_type: annotationType,
        frame_interval_sec: Number(frameInterval) || 1,
        assignments_per_task: Number(assignmentsPerTask) || 2,
        agreement_threshold: Number(agreementThreshold) || 0.75,
        iou_threshold: Number(iouThreshold) || 0.5,
        participant_rules: {
          specialization, group: groupRule, assignment_scope: assignmentScope, stage_pools: {},
          ai_prelabel_enabled: aiEnabled, ai_model: aiModel.trim() || "baseline-box-v1",
          ai_confidence_threshold: Number(aiConfidenceThreshold) || 0.7,
          video_keyframe_interval: Number(videoKeyframeInterval) || 1, tracking_algorithm: trackingAlgorithm,
          task_batch_size: Number(taskBatchSize) || 10, min_sequence_size: Number(minSequenceSize) || 3,
          golden_candidate_threshold: 0.9, golden_promotion_target: 10, annotation_golden_interval: 9,
          interval_review_padding_sec: 3, stuck_assignment_ttl_minutes: 30,
        },
        label_schema: labels, allowed_annotator_ids: selectedAnnotators, allowed_reviewer_ids: [],
      });
    },
    onSuccess: async () => { setError(null); await queryClient.invalidateQueries({ queryKey: ["project", projectId] }); await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] }); },
    onError: (err: any) => setError(err?.response?.data?.detail || err?.message || "Не удалось сохранить настройки"),
  });

  const importParticipantsMutation = useMutation({
    mutationFn: async () => { if (!projectId || !participantsCsv) throw new Error("Сначала выберите CSV-файл"); return projectsAPI.importParticipantsCsv(projectId, participantsCsv); },
    onSuccess: async (result) => {
      setDistributionResult(`✅ Импорт CSV завершён: создано ${result.created_users}, привязано ${result.linked_memberships}, пропущено ${result.skipped_rows}.`);
      await queryClient.invalidateQueries({ queryKey: ["participants", "annotator"] });
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
    onError: (err: any) => setError(err?.response?.data?.detail || err?.message || "Ошибка импорта CSV"),
  });

  const manualDistributeMutation = useMutation({
    mutationFn: async () => { if (!projectId) throw new Error("ID проекта отсутствует"); return projectsAPI.manualDistributeAssignments(projectId, selectedAnnotators, 100); },
    onSuccess: (result) => setDistributionResult(`✅ Ручное распределение завершено: проверено ${result.work_items_considered} заданий, создано ${result.assignments_created} назначений.`),
    onError: (err: any) => setError(err?.response?.data?.detail || err?.message || "Ошибка ручного распределения"),
  });

  const toggle = (id: string, current: string[], setter: (value: string[]) => void) => {
    setter(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const addLabel = () => setLabels((current) => [...current, { name: "", color: getDefaultLabelColor(current.length) }]);
  const removeLabel = (index: number) => setLabels((current) => current.filter((_, i) => i !== index));
  const updateLabel = (index: number, patch: Partial<ProjectLabel>) => setLabels((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const onSubmit = (event: FormEvent) => { event.preventDefault(); saveMutation.mutate(); };

  if (!canEditProject(user?.role)) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">⚙️ Настройки workflow</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Только владельцы проектов и администраторы могут редактировать настройки.</p>
        <Link to="/projects" className="btn-primary mt-5 inline-block">← К проектам</Link>
      </div>
    );
  }

  if (projectQuery.isLoading) return <LoadingSpinner size="lg" />;
  if (!projectQuery.data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">❌ Проект не найден</h1>
        <Link to="/projects" className="btn-primary mt-5 inline-block">← К проектам</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Проекты / {projectQuery.data.title}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">⚙️ Настройки workflow</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Настройте правила разметки, AI-предразметку, пул участников и обработку видео.</p>
        </div>
        <div className="flex gap-3">
          <button type="button" className="btn-secondary" onClick={() => navigate(`/projects/${projectId}`)}>← Назад к проекту</button>
          <button type="button" className="btn-primary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "💾 Сохраняем..." : "💾 Сохранить"}
          </button>
        </div>
      </div>

      {hasWorkItems && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          ⚠️ В этом проекте уже есть задания. Изменение правил разметки или порогов качества затронет только будущие импорты.
        </div>
      )}

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">❌ {error}</div>}

      <form onSubmit={onSubmit} className="space-y-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* Левая колонка: основные настройки */}
          <div className="card space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">📦 Тип аннотации</label>
              <select className="input-field" value={annotationType} onChange={(e) => setAnnotationType(e.target.value as Project["annotation_type"])}>
                <option value="bbox">BBox (ограничивающие рамки)</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Текущая версия поддерживает только разметку рамками.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">🎞️ Интервал кадров (сек)</label>
                <input type="number" min="0.1" step="0.1" className="input-field" value={frameInterval} onChange={(e) => setFrameInterval(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">👥 Аннотаторов на задание</label>
                <input type="number" min="1" step="1" className="input-field" value={assignmentsPerTask} onChange={(e) => setAssignmentsPerTask(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">📊 Порог согласия</label>
                <input type="number" min="0" max="1" step="0.05" className="input-field" value={agreementThreshold} onChange={(e) => setAgreementThreshold(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">🔍 Порог IoU</label>
                <input type="number" min="0" max="1" step="0.05" className="input-field" value={iouThreshold} onChange={(e) => setIouThreshold(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">🔧 Специализация</label>
                <input className="input-field" value={specialization} onChange={(e) => setSpecialization(e.target.value)} placeholder="aerial vision" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">👥 Группа</label>
                <input className="input-field" value={groupRule} onChange={(e) => setGroupRule(e.target.value)} placeholder="group-42" />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">🎯 Область назначения</label>
              <select className="input-field" value={assignmentScope} onChange={(e) => setAssignmentScope(e.target.value as any)}>
                <option value="selected_only">Только выбранные аннотаторы</option>
                <option value="all">Все доступные аннотаторы</option>
                <option value="specialists">С приоритетом специализации</option>
                <option value="group_only">Только одна группа</option>
              </select>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-white">🤖 AI-предразметка</div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Автоматическая предразметка рамок перед открытием задания.</div>
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
                  Включена
                </label>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Название модели</label>
                  <input className="input-field" value={aiModel} onChange={(e) => setAiModel(e.target.value)} disabled={!aiEnabled} placeholder="baseline-box-v1" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Порог уверенности</label>
                  <input type="number" min="0" max="1" step="0.05" className="input-field" value={aiConfidenceThreshold} onChange={(e) => setAiConfidenceThreshold(e.target.value)} disabled={!aiEnabled} />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="text-sm font-medium text-gray-900 dark:text-white">🎬 Обработка видео</div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Интервал ключевых кадров</label>
                  <input type="number" min="1" step="1" className="input-field" value={videoKeyframeInterval} onChange={(e) => setVideoKeyframeInterval(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Алгоритм трекинга</label>
                  <select className="input-field" value={trackingAlgorithm} onChange={(e) => setTrackingAlgorithm(e.target.value as any)}>
                    {TRACKING_ALGORITHMS.map((algo) => <option key={algo} value={algo}>{algo}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="text-sm font-medium text-gray-900 dark:text-white">📦 Упаковка задач и подготовка к валидации</div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Кадров в задании</label>
                  <input type="number" min="1" step="1" className="input-field" value={taskBatchSize} onChange={(e) => setTaskBatchSize(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Мин. соседних кадров</label>
                  <input type="number" min="1" step="1" className="input-field" value={minSequenceSize} onChange={(e) => setMinSequenceSize(e.target.value)} />
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                💡 Задачи группируются в упорядоченные последовательности кадров для межкадровой валидации.
              </div>
            </div>
          </div>

          {/* Правая колонка: метки */}
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-gray-900 dark:text-white">🏷️ Схема меток</div>
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">Определите классы, цвета, правила и примеры для аннотаторов.</div>
              </div>
              <button type="button" className="btn-secondary" onClick={addLabel}>+ Добавить метку</button>
            </div>

            <div className="space-y-3">
              {labels.map((label, index) => (
                <div key={index} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Название</label>
                      <input className="input-field" value={label.name} onChange={(e) => updateLabel(index, { name: e.target.value })} placeholder="drone" />
                    </div>
                    <button type="button" className="btn-secondary" onClick={() => removeLabel(index)} disabled={labels.length <= 1}>Удалить</button>
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Цвет</label>
                    <input type="color" className="h-10 w-20 rounded border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950" value={label.color || getDefaultLabelColor(index)} onChange={(e) => updateLabel(index, { color: e.target.value })} />
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Описание</label>
                    <input className="input-field" value={label.description ?? ""} onChange={(e) => updateLabel(index, { description: e.target.value })} placeholder="Что относится к этому классу?" />
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Правила</label>
                    <textarea className="input-field min-h-[88px]" value={joinLines(label.rules)} onChange={(e) => updateLabel(index, { rules: splitLines(e.target.value) })} placeholder="Рисуйте плотную рамку\nОтмечайте все видимые объекты\nОставляйте комментарии при сомнениях" />
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Хорошие примеры</label>
                      <textarea className="input-field min-h-[88px]" value={joinLines(label.examples?.good)} onChange={(e) => updateLabel(index, { examples: { ...(label.examples ?? {}), good: splitLines(e.target.value) } })} placeholder="Дрон виден полностью\nЧастично скрытый дрон всё ещё узнаваем" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Плохие примеры</label>
                      <textarea className="input-field min-h-[88px]" value={joinLines(label.examples?.bad)} onChange={(e) => updateLabel(index, { examples: { ...(label.examples ?? {}), bad: splitLines(e.target.value) } })} placeholder="Птица вместо дрона\nРамка слишком большая" />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400">🎨 Палитра меток</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {labels.map((label, index) => (
                  <div key={`palette-${index}`} className="flex items-center gap-2 rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-900">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: label.color || getDefaultLabelColor(index) }} />
                    <span>{label.name || `метка_${index + 1}`}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Пул аннотаторов */}
        <div className="card space-y-5">
          <ParticipantSelector
            title="👥 Пул аннотаторов"
            hint="Только выбранные здесь аннотаторы могут получать задания, если область назначения — «Только выбранные»."
            items={annotatorsQuery.data?.items ?? []}
            selected={selectedAnnotators}
            onToggle={(id) => toggle(id, selectedAnnotators, setSelectedAnnotators)}
          />

          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">📁 Массовый импорт участников из CSV</div>
            <input type="file" accept=".csv" className="mt-2 block w-full text-sm" onChange={(e) => setParticipantsCsv(e.target.files?.[0] ?? null)} />
            <button type="button" className="btn-secondary mt-3" onClick={() => importParticipantsMutation.mutate()} disabled={!participantsCsv || importParticipantsMutation.isPending}>
              {importParticipantsMutation.isPending ? "⏳ Импорт..." : "📥 Импортировать CSV"}
            </button>
          </div>

          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">🎯 Ручное распределение заданий</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Немедленно назначить ожидающие задачи выбранным аннотаторам.</div>
            <button type="button" className="btn-secondary mt-3" onClick={() => manualDistributeMutation.mutate()} disabled={selectedAnnotators.length === 0 || manualDistributeMutation.isPending}>
              {manualDistributeMutation.isPending ? "⏳ Распределение..." : "📤 Распределить задачи"}
            </button>
          </div>

          {distributionResult && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-700">{distributionResult}</div>}
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={() => navigate(`/projects/${projectId}`)}>↩️ Отмена</button>
          <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "💾 Сохраняем..." : "💾 Сохранить настройки"}
          </button>
        </div>
      </form>
    </div>
  );
}
