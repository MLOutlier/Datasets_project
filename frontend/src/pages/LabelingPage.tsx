import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";
import { getTaskGroupLabel } from "../lib/taskFlowCopy";

type ProjectTab = "available" | "active" | "completed";

const stageTitles: Record<string, string> = {
  video_annotation: "Разметка видео",
  video_interval_validation: "Валидация интервалов",
  bbox_annotation: "Разметка объектов",
  bbox_validation: "Валидация объектов",
  text_annotation: "Текстовая разметка",
  image_annotation: "Разметка изображений",
  classification: "Классификация",
  comparison: "Сравнение",
};

const taskTypeOptions = Object.keys(stageTitles);

function stageTitle(project: any) {
  return stageTitles[project.stage] ?? stageTitles[project.task_type] ?? project.stage_title ?? project.project_title;
}

function formatDate(value?: string) {
  if (!value) return "нет";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "нет";
  return date.toLocaleDateString();
}

export function LabelingPage() {
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<ProjectTab>("available");
  const [search, setSearch] = useState("");
  const [taskType, setTaskType] = useState("");

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
  const filteredProjects = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return visibleProjects.filter((project: any) => {
      const matchesSearch = !needle || `${project.project_title} ${project.linked_project_title || ""} ${project.instructions || ""}`.toLowerCase().includes(needle);
      const matchesType = !taskType || project.task_type === taskType || project.stage === taskType;
      return matchesSearch && matchesType;
    });
  }, [search, taskType, visibleProjects]);

  const queueCount =
    availableProjects.reduce((sum, item) => sum + Number(item.available_count || 0), 0) +
    activeProjects.reduce((sum, item) => sum + Number(item.active_count || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Проекты для разметки</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Очереди исполнителя по проектам и этапам workflow.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="text-sm text-gray-500 dark:text-gray-400">Доступные</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{availableProjects.length}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="text-sm text-gray-500 dark:text-gray-400">Активные</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{activeProjects.length}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="text-sm text-gray-500 dark:text-gray-400">В очереди</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{queueCount}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="text-sm text-gray-500 dark:text-gray-400">Завершенные</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">{completedProjects.length}</div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
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
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr,260px]">
          <input className="input-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск по проекту или инструкции" />
          <select className="input-field" value={taskType} onChange={(event) => setTaskType(event.target.value)}>
            <option value="">Все типы задач</option>
            {taskTypeOptions.map((item) => <option key={item} value={item}>{stageTitles[item]}</option>)}
          </select>
        </div>
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
      ) : filteredProjects.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Ничего не найдено</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Измените вкладку, поиск или фильтр типа задачи.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3">Проект</th>
                  <th className="px-4 py-3">Этап</th>
                  <th className="px-4 py-3">Тип</th>
                  <th className="px-4 py-3">Доступно</th>
                  <th className="px-4 py-3">В работе</th>
                  <th className="px-4 py-3">Отправлено</th>
                  <th className="px-4 py-3">Принято</th>
                  <th className="px-4 py-3">Всего</th>
                  <th className="px-4 py-3">Активность</th>
                  <th className="px-4 py-3 text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {filteredProjects.map((project: any) => {
                  const completedCount = Number(project.completed_count ?? Number(project.accepted_count || 0) + Number(project.rejected_count || 0));
                  return (
                    <tr key={project.stage_project_id ?? `${project.project_id}:${project.stage ?? "parent"}`} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 dark:text-white">{project.linked_project_title ?? project.project_title}</div>
                        <div className="mt-1 max-w-sm truncate text-xs text-gray-500 dark:text-gray-400">{project.project_title}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{stageTitle(project)}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                        <div>{getTaskGroupLabel(project.task_type || project.stage)}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{project.widget_type ?? "widget"}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{project.available_count}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{project.active_count}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{project.submitted_count}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{project.accepted_count}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{project.total_assignments || completedCount}</td>
                      <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{formatDate(project.last_activity_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link to={project.route || `/labeling/projects/${project.project_id}`} className="btn-primary">
                          Открыть
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
