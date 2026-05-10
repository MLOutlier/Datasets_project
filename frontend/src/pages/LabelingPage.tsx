import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

type ProjectTab = "available" | "active" | "completed";

const stageTitles: Record<string, string> = {
  interval_annotation: "Разметка интервалов",
  interval_validation: "Валидация интервалов",
  bbox_annotation: "Разметка объектов",
  bbox_validation: "Валидация объектов",
};

function stageTitle(project: any) {
  return stageTitles[project.stage] ?? project.stage_title ?? project.project_title;
}

export function LabelingPage() {
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<ProjectTab>("available");

  const projectsQuery = useQuery({
    queryKey: ["annotator-projects"],
    queryFn: () => annotatorAPI.projects(),
    enabled: user?.role === "annotator" || user?.role === "admin",
  });

  if (user?.role !== "annotator" && user?.role !== "admin") {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Проекты разметки</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Этот раздел доступен исполнителям и администраторам.</p>
      </div>
    );
  }

  const availableProjects = projectsQuery.data?.available_projects ?? [];
  const activeProjects = projectsQuery.data?.active_projects ?? [];
  const completedProjects = projectsQuery.data?.completed_projects ?? [];
  const visibleProjects = tab === "available" ? availableProjects : tab === "active" ? activeProjects : completedProjects;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Проекты для разметки</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Каждый этап показан отдельной карточкой, но связан с исходным проектом заказчика.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Доступные этапы</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{availableProjects.length}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Активные этапы</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{activeProjects.length}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Заданий в очереди</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
            {availableProjects.reduce((sum, item) => sum + Number(item.available_count || 0), 0) +
              activeProjects.reduce((sum, item) => sum + Number(item.active_count || 0), 0)}
          </div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Завершенные этапы</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{completedProjects.length}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={`btn-secondary ${tab === "available" ? "ring-2 ring-blue-400" : ""}`} onClick={() => setTab("available")}>
          Доступные
        </button>
        <button type="button" className={`btn-secondary ${tab === "active" ? "ring-2 ring-blue-400" : ""}`} onClick={() => setTab("active")}>
          Активные
        </button>
        <button type="button" className={`btn-secondary ${tab === "completed" ? "ring-2 ring-blue-400" : ""}`} onClick={() => setTab("completed")}>
          Завершенные
        </button>
      </div>

      {projectsQuery.isLoading ? (
        <div className="card flex justify-center p-10">
          <LoadingSpinner size="lg" />
        </div>
      ) : projectsQuery.isError ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Не удалось загрузить проекты</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {(projectsQuery.error as any)?.response?.data?.detail || (projectsQuery.error as Error)?.message || "Проверьте доступность backend и попробуйте еще раз."}
          </p>
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">В этой вкладке пока пусто</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {tab === "available"
              ? "Здесь появятся этапы с новыми заданиями."
              : tab === "active"
                ? "Здесь будут этапы, по которым уже начата работа или ожидается следующий шаг workflow."
                : "Завершенные этапы остаются здесь, чтобы связь с проектом не исчезала после последнего задания."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {visibleProjects.map((project) => {
            const completedCount = Number(project.completed_count ?? Number(project.accepted_count || 0) + Number(project.rejected_count || 0));
            return (
              <div key={project.stage_project_id ?? `${project.project_id}:${project.stage ?? "parent"}`} className="card space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {project.project_status} · часть проекта {project.linked_project_title ?? project.project_title}
                    </div>
                    <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{stageTitle(project)}</h2>
                  </div>
                  <span className="badge badge-warning">
                    {tab === "active"
                      ? `${project.active_count} в работе`
                      : tab === "completed"
                        ? `${completedCount} завершено`
                        : `${project.available_count} доступно`}
                  </span>
                </div>

                <div className="text-sm text-gray-600 line-clamp-3 dark:text-gray-400">
                  {project.instructions || "Инструкция проекта пока не заполнена."}
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>{project.linked_project_title ?? project.project_title}</span>
                  <span>{project.label_schema.length} меток</span>
                  <span>{project.total_assignments} заданий всего</span>
                  <span>{project.active_count} в работе</span>
                  <span>{project.submitted_count} отправлено</span>
                  <span>{project.accepted_count} принято</span>
                  {tab === "completed" ? <span>{project.rejected_count} отклонено</span> : null}
                </div>

                <div className="flex justify-end">
                  <Link to={project.route || `/labeling/projects/${project.project_id}`} className="btn-primary">
                    Открыть этап
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
