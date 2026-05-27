import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { annotatorAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { getTaskFlowCopy, getTaskGroupLabel } from "../lib/taskFlowCopy";

export default function AnnotatorProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const projectQuery = useQuery({
    queryKey: ["annotator-project-detail", projectId],
    queryFn: () => annotatorAPI.projectDetail(projectId!),
    enabled: !!projectId,
  });

  const intervalChunkQuery = useQuery({
    queryKey: ["interval-chunk-queue", projectId],
    queryFn: () => annotatorAPI.intervalChunkQueue(),
    enabled: !!projectId,
  });

  const intervalValidationQuery = useQuery({
    queryKey: ["interval-validation-queue", projectId],
    queryFn: () => annotatorAPI.intervalValidationQueue(),
    enabled: !!projectId,
  });

  const bboxValidationQuery = useQuery({
    queryKey: ["bbox-validation-queue", projectId],
    queryFn: () => annotatorAPI.bboxValidationQueue(),
    enabled: !!projectId,
  });

  const nextAssignmentMutation = useMutation({
    mutationFn: () => annotatorAPI.nextProjectAssignment(projectId!),
    onSuccess: (result) => navigate(`/labeling/assignments/${result.assignment_id}`),
  });

  if (projectQuery.isLoading) return <LoadingSpinner size="lg" />;
  if (!projectQuery.data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">❌ Проект не найден</h1>
        <Link to="/labeling" className="btn-primary mt-4 inline-block">← К проектам</Link>
      </div>
    );
  }

  const project = projectQuery.data;
  const taskType = String(project.task_type || "bbox_annotation");
  const taskCopy = getTaskFlowCopy(taskType);
  const taskGroupLabelVal = getTaskGroupLabel(taskType);
  const primaryActionLabel = project.active_assignment_id ? "Продолжить разметку" : project.next_assignment_id ? "Начать разметку" : "Нет доступных заданий";
  const intervalChunkCount = (intervalChunkQuery.data?.items ?? []).filter((item: any) => item.project_id === project.project_id).length;
  const intervalValidationCount = (intervalValidationQuery.data?.items ?? []).filter((item: any) => item.project_id === project.project_id).length;
  const bboxValidationCount = (bboxValidationQuery.data?.items ?? []).filter((item: any) => item.project_id === project.project_id).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">{project.project_status === "active" ? "Активен" : project.project_status}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.project_title}</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{project.description || "Описание проекта пока не добавлено."}</p>
        </div>
        <Link to="/labeling" className="btn-secondary">← К проектам</Link>
      </div>

      <div className={`rounded-lg border p-4 ${taskCopy.group === "video" ? "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100" : "border-gray-200 bg-gray-50 text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"}`}>
        <div className="text-xs uppercase tracking-wide text-gray-500">{taskGroupLabelVal}</div>
        <div className="mt-1 text-lg font-semibold">{taskCopy.projectTitle}</div>
        <div className="mt-2 text-sm opacity-90">{taskCopy.projectDescription}</div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <StatItem label="Доступно" value={project.stats.available_count} />
        <StatItem label="В работе" value={project.stats.active_count} />
        <StatItem label="Отправлено" value={project.stats.submitted_count} />
        <StatItem label="Принято" value={project.stats.accepted_count} />
        <StatItem label="Отклонено" value={project.stats.rejected_count} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatItem label="Пакеты заданий" value={project.stats.batch_count} />
        <StatItem label="Кадры для валидации" value={project.stats.validation_ready_count} />
        <StatItem label="Завершено" value={project.stats.completed_count} />
      </div>

      <div className="card space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">📋 Задание проекта</h2>
          <p className="mt-1 text-sm text-gray-600">Проект использует один тип задания и один основной виджет.</p>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {taskType === "video_annotation" && (
            <Link to={`/labeling/intervals?projectId=${project.project_id}&stage=intervals`} className="rounded-lg border border-blue-200 bg-blue-50 p-4 transition hover:border-blue-300">
              <div className="text-sm text-gray-500">Виджет</div>
              <div className="mt-2 text-lg font-semibold text-gray-900">Интервалы видео</div>
              <div className="mt-1 text-sm text-gray-600">{taskCopy.annotatorDescription}</div>
              <div className="mt-3 text-3xl font-bold text-gray-900">{intervalChunkCount}</div>
            </Link>
          )}
          {taskType === "video_interval_validation" && (
            <Link to={`/labeling/intervals?projectId=${project.project_id}&stage=interval-validation`} className="rounded-lg border border-blue-200 bg-blue-50 p-4 transition hover:border-blue-300">
              <div className="text-sm text-gray-500">Виджет</div>
              <div className="mt-2 text-lg font-semibold text-gray-900">Валидация интервалов</div>
              <div className="mt-1 text-sm text-gray-600">{taskCopy.annotatorDescription}</div>
              <div className="mt-3 text-3xl font-bold text-gray-900">{intervalValidationCount}</div>
            </Link>
          )}
          {taskType === "bbox_annotation" && (
            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="text-sm text-gray-500">Виджет</div>
              <div className="mt-2 text-lg font-semibold text-gray-900">BBox-разметка</div>
              <div className="mt-3 text-3xl font-bold text-gray-900">{project.stats.available_count + project.stats.active_count}</div>
              <button className="btn-primary mt-4 w-full" onClick={() => nextAssignmentMutation.mutate()} disabled={nextAssignmentMutation.isPending || (!project.active_assignment_id && !project.next_assignment_id)}>
                {nextAssignmentMutation.isPending ? "Открываем..." : primaryActionLabel}
              </button>
            </div>
          )}
          {taskType === "bbox_validation" && (
            <Link to={`/labeling/bbox-validation?projectId=${project.project_id}`} className="rounded-lg border border-gray-200 p-4 transition hover:border-blue-300">
              <div className="text-sm text-gray-500">Виджет</div>
              <div className="mt-2 text-lg font-semibold text-gray-900">BBox-валидация</div>
              <div className="mt-3 text-3xl font-bold text-gray-900">{bboxValidationCount}</div>
            </Link>
          )}
          {["text_annotation", "image_annotation", "classification", "comparison"].includes(taskType) && (
            <Link to={`/labeling/generic/${project.project_id}`} className="rounded-lg border border-gray-200 p-4 transition hover:border-blue-300">
              <div className="text-sm text-gray-500">Виджет</div>
              <div className="mt-2 text-lg font-semibold text-gray-900">{String(project.widget_type || "generic")}</div>
              <div className="mt-3 text-3xl font-bold text-gray-900">{project.stats.available_count + project.stats.active_count}</div>
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr,0.42fr]">
        <div className="card space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">📖 Инструкция</h2>
          <p className="text-sm text-gray-600">Перед началом внимательно прочитайте инструкцию. После этого система будет показывать ваши кадры по очереди.</p>
          <div className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
            {project.instructions || "Инструкция пока не добавлена."}
          </div>
          {project.instructions_file_uri && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
              <div className="font-medium text-gray-900">📎 Прикреплённый файл инструкции</div>
              <a className="mt-2 block text-blue-600 hover:underline" href={project.instructions_file_uri} target="_blank" rel="noreferrer">{project.instructions_file_name || "инструкция"}</a>
              <div className="mt-1 text-xs text-gray-500">v{project.instructions_version ?? 0}{project.instructions_updated_at ? ` | ${new Date(project.instructions_updated_at).toLocaleString()}` : ""}</div>
            </div>
          )}
          {taskType === "bbox_annotation" && (
            <div className="flex justify-end">
              <button className="btn-primary" onClick={() => nextAssignmentMutation.mutate()} disabled={nextAssignmentMutation.isPending || (!project.active_assignment_id && !project.next_assignment_id)}>
                {nextAssignmentMutation.isPending ? "Открываем..." : primaryActionLabel}
              </button>
            </div>
          )}
          {nextAssignmentMutation.isError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">Не удалось открыть следующее задание.</div>}
        </div>

        <div className="space-y-4">
          <div className="card space-y-3">
            <div className="text-lg font-semibold text-gray-900">🏷️ Метки</div>
            {project.label_schema.map((label) => (
              <div key={label.name} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: label.color || "#2563eb" }} />
                  <span className="font-medium text-gray-900">{label.name}</span>
                </div>
                {label.description && <div className="mt-2 text-sm text-gray-600">{label.description}</div>}
              </div>
            ))}
          </div>

          <div className="card space-y-2 text-sm text-gray-700">
            <div className="text-lg font-semibold text-gray-900">⚙️ Параметры workflow</div>
            <div>Интервал кадров: {project.frame_interval_sec} с</div>
            <div>Размер пакета: {Number(project.participant_rules?.task_batch_size || 10)} кадров</div>
            <div>Мин. длина последовательности: {Number(project.participant_rules?.min_sequence_size || 3)} кадра</div>
            <div>AI-предразметка: {project.participant_rules?.ai_prelabel_enabled === false ? "выключена" : "включена"}</div>
            <div>AI-модель: {String(project.participant_rules?.ai_model || "baseline-box-v1")}</div>
            <div>Трекинг: {String(project.participant_rules?.tracking_algorithm || "CSRT")}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}
