import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { annotatorAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";

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
    onSuccess: (result) => {
      navigate(`/labeling/assignments/${result.assignment_id}`);
    },
  });

  if (projectQuery.isLoading) {
    return <LoadingSpinner size="lg" />;
  }

  if (!projectQuery.data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Проект не найден</h1>
        <Link to="/labeling" className="btn-primary mt-4 inline-block">
          К проектам
        </Link>
      </div>
    );
  }

  const project = projectQuery.data;
  const primaryActionLabel = project.active_assignment_id ? "Продолжить разметку" : project.next_assignment_id ? "Начать разметку" : "Нет доступных заданий";
  const intervalChunkCount = (intervalChunkQuery.data?.items ?? []).filter((item: any) => item.project_id === project.project_id).length;
  const intervalValidationCount = (intervalValidationQuery.data?.items ?? []).filter((item: any) => item.project_id === project.project_id).length;
  const bboxValidationCount = (bboxValidationQuery.data?.items ?? []).filter((item: any) => item.project_id === project.project_id).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{project.project_status}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.project_title}</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{project.description || "Описание проекта пока не добавлено."}</p>
        </div>
        <Link to="/labeling" className="btn-secondary">
          К проектам
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Доступно</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.available_count}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">В работе</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.active_count}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Отправлено</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.submitted_count}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Принято</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.accepted_count}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Отклонено</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.rejected_count}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Пакеты заданий</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.batch_count}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Кадры для валидации</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.validation_ready_count}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Завершено</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.completed_count}</div>
        </div>
      </div>

      <div className="card space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Этапы проекта</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Рабочие этапы привязаны к этому проекту. Если на этапе нет задач, дождитесь завершения предыдущего этапа или появления новых assignment.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
          <Link to={`/labeling/intervals?projectId=${project.project_id}&stage=intervals`} className="rounded-lg border border-gray-200 p-4 transition hover:border-blue-300 dark:border-gray-800 dark:hover:border-blue-700">
            <div className="text-sm text-gray-500 dark:text-gray-400">Этап 1</div>
            <div className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">Интервалы видео</div>
            <div className="mt-3 text-3xl font-bold text-gray-900 dark:text-white">{intervalChunkCount}</div>
          </Link>
          <Link to={`/labeling/intervals?projectId=${project.project_id}&stage=interval-validation`} className="rounded-lg border border-gray-200 p-4 transition hover:border-blue-300 dark:border-gray-800 dark:hover:border-blue-700">
            <div className="text-sm text-gray-500 dark:text-gray-400">Этап 2</div>
            <div className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">Валидация интервалов</div>
            <div className="mt-3 text-3xl font-bold text-gray-900 dark:text-white">{intervalValidationCount}</div>
          </Link>
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="text-sm text-gray-500 dark:text-gray-400">Этап 3</div>
            <div className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">BBox-разметка</div>
            <div className="mt-3 text-3xl font-bold text-gray-900 dark:text-white">{project.stats.available_count + project.stats.active_count}</div>
            <button
              type="button"
              className="btn-primary mt-4 w-full"
              onClick={() => nextAssignmentMutation.mutate()}
              disabled={nextAssignmentMutation.isPending || (!project.active_assignment_id && !project.next_assignment_id)}
            >
              {nextAssignmentMutation.isPending ? "Открываем..." : primaryActionLabel}
            </button>
          </div>
          <Link to={`/labeling/intervals?projectId=${project.project_id}&stage=bbox-validation`} className="rounded-lg border border-gray-200 p-4 transition hover:border-blue-300 dark:border-gray-800 dark:hover:border-blue-700">
            <div className="text-sm text-gray-500 dark:text-gray-400">Этап 4</div>
            <div className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">BBox-валидация</div>
            <div className="mt-3 text-3xl font-bold text-gray-900 dark:text-white">{bboxValidationCount}</div>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr,0.42fr]">
        <div className="card space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Instructions</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Перед началом внимательно прочитайте инструкцию. После этого система будет показывать ваши кадры по очереди.
            </p>
          </div>

          <div className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
            {project.instructions || "Инструкция пока не добавлена."}
          </div>

          {project.instructions_file_uri ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-950">
              <div className="font-medium text-gray-900 dark:text-white">Прикрепленный файл инструкции</div>
              <div className="mt-2">
                <a className="text-blue-600 hover:underline dark:text-blue-400" href={project.instructions_file_uri} target="_blank" rel="noreferrer">
                  {project.instructions_file_name || "инструкция"}
                </a>
              </div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                v{project.instructions_version ?? 0}
                {project.instructions_updated_at ? ` | ${new Date(project.instructions_updated_at).toLocaleString()}` : ""}
              </div>
            </div>
          ) : null}

          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary"
              onClick={() => nextAssignmentMutation.mutate()}
              disabled={nextAssignmentMutation.isPending || (!project.active_assignment_id && !project.next_assignment_id)}
            >
              {nextAssignmentMutation.isPending ? "Открываем..." : primaryActionLabel}
            </button>
          </div>
          {nextAssignmentMutation.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">Не удалось открыть следующее задание.</div>
          ) : null}
        </div>

        <div className="space-y-4">
          <div className="card space-y-3">
            <div className="text-lg font-semibold text-gray-900 dark:text-white">Метки</div>
            <div className="space-y-2">
              {project.label_schema.map((label) => (
                <div key={label.name} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: label.color || "#2563eb" }} />
                    <span className="font-medium text-gray-900 dark:text-white">{label.name}</span>
                  </div>
                  {label.description ? <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">{label.description}</div> : null}
                </div>
              ))}
            </div>
          </div>

          <div className="card space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <div className="text-lg font-semibold text-gray-900 dark:text-white">Параметры workflow</div>
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
