import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

type ProjectTab = "available" | "active" | "completed";

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
  const visibleProjects =
    tab === "available" ? availableProjects : tab === "active" ? activeProjects : completedProjects;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Проекты для разметки</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Откройте конкретный проект, изучите инструкцию и выберите доступный этап внутри него.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Доступные проекты</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{availableProjects.length}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Активные проекты</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{activeProjects.length}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Заданий в очереди</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
            {availableProjects.reduce((sum, item) => sum + item.available_count, 0) +
              activeProjects.reduce((sum, item) => sum + item.active_count, 0)}
          </div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Завершенные проекты</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{completedProjects.length}</div>
        </div>
      </div>

      <div className="flex gap-2">
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
              ? "Здесь появятся проекты с новыми заданиями."
              : tab === "active"
                ? "Здесь будут проекты, по которым уже начата работа."
                : "Завершенные проекты остаются здесь, чтобы не исчезать после последнего задания."}
          </p>
          {tab === "available" ? (
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Если заказчик только что загрузил медиа, ему еще нужно нажать <span className="font-medium">Finalize import</span>, чтобы проект и задания появились здесь.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {visibleProjects.map((project) => (
            <div key={project.project_id} className="card space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{project.project_status}</div>
                  <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{project.project_title}</h2>
                </div>
                <span className="badge badge-warning">
                  {tab === "active"
                    ? `${project.active_count} в работе`
                    : tab === "completed"
                      ? `${project.completed_count ?? project.accepted_count + project.rejected_count} завершено`
                      : `${project.available_count} доступно`}
                </span>
              </div>

              <div className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
                {project.instructions || "Инструкция проекта пока не заполнена."}
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span>{project.label_schema.length} меток</span>
                <span>{project.total_assignments} заданий всего</span>
                <span>{project.submitted_count} отправлено</span>
                <span>{project.accepted_count} принято</span>
                {tab === "completed" ? <span>{project.rejected_count} отклонено</span> : null}
              </div>

              <div className="flex justify-end">
                <Link to={`/labeling/projects/${project.project_id}`} className="btn-primary">
                  Открыть проект
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
