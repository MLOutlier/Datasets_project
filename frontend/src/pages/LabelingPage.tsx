import { Link } from "react-router-dom";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

// В начале файла, после импортов, добавь:
const STATUS_LABELS: Record<string, string> = {
  active: "Активный",
  open: "Открыт",
  closed: "Закрыт",
  pending: "Ожидает",
  in_progress: "В работе",
  completed: "Завершён",
};

type ProjectTab = "available" | "active" | "completed";

const STAGE_TITLES: Record<string, string> = {
  video_annotation: "Разметка видео",
  video_interval_validation: "Валидация интервалов",
  bbox_annotation: "Разметка объектов",
  bbox_validation: "Валидация объектов",
  text_annotation: "Текстовая разметка",
  image_annotation: "Разметка изображений",
  classification: "Классификация",
  comparison: "Сравнение",
};

function stageTitle(project: any) {
  return STAGE_TITLES[project.stage] ?? project.stage_title ?? project.project_title;
}

function taskGroupLabel(taskType: string) {
  const map: Record<string, string> = {
    video_annotation: "Видео",
    video_interval_validation: "Видео",
    bbox_annotation: "BBox",
    bbox_validation: "BBox",
    text_annotation: "Текст",
    image_annotation: "Изображения",
    classification: "Классификация",
    comparison: "Сравнение",
  };
  return map[taskType] ?? taskType;
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
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Этот раздел доступен только исполнителям и администраторам.</p>
      </div>
    );
  }

  const available = projectsQuery.data?.available_projects ?? [];
  const active = projectsQuery.data?.active_projects ?? [];
  const completed = projectsQuery.data?.completed_projects ?? [];
  const visible = tab === "available" ? available : tab === "active" ? active : completed;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Проекты для разметки</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Каждый проект — самостоятельный тип задания со своим интерфейсом и очередью.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard label="Доступные этапы" value={available.length} />
        <StatCard label="Активные этапы" value={active.length} />
        <StatCard label="Заданий в очереди" value={
          available.reduce((s, i) => s + Number(i.available_count || 0), 0) +
          active.reduce((s, i) => s + Number(i.active_count || 0), 0)
        } />
        <StatCard label="Завершённые этапы" value={completed.length} />
      </div>

      <div className="flex flex-wrap gap-2">
        {(["available", "active", "completed"] as ProjectTab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`btn-secondary ${tab === t ? "ring-2 ring-blue-400" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "available" ? "Доступные" : t === "active" ? "Активные" : "Завершённые"}
          </button>
        ))}
      </div>

      {projectsQuery.isLoading ? (
        <div className="card flex justify-center p-10"><LoadingSpinner size="lg" /></div>
      ) : projectsQuery.isError ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Не удалось загрузить проекты</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Проверьте подключение к серверу.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Пока пусто</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {tab === "available" ? "Здесь появятся новые этапы для разметки." :
             tab === "active" ? "Здесь будут этапы, по которым уже начата работа." :
             "Завершённые этапы остаются здесь для истории."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {visible.map((project) => {
            const completedCount = Number(project.completed_count ?? Number(project.accepted_count || 0) + Number(project.rejected_count || 0));
            return (
              <div key={project.stage_project_id ?? `${project.project_id}:${project.stage ?? "parent"}`} className="card space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      <span>{project.project_status}</span>
                      <span>· {taskGroupLabel(project.task_type || project.stage)}</span>
                      <span>· {project.widget_type ?? "widget"}</span>
                    </div>
                    <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{stageTitle(project)}</h2>
                  </div>
                  <span className="badge badge-warning">
                    {tab === "active" ? `${project.active_count} в работе` :
                     tab === "completed" ? `${completedCount} завершено` :
                     `${project.available_count} доступно`}
                  </span>
                </div>
                <div className="text-sm text-gray-600 line-clamp-3 dark:text-gray-400">
                  {project.instructions || "Инструкция пока не добавлена."}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>{project.linked_project_title ?? project.project_title}</span>
                  <span>{project.label_schema.length} меток</span>
                  <span>{project.total_assignments} заданий</span>
                  <span>{project.active_count} в работе</span>
                  <span>{project.submitted_count} отправлено</span>
                  <span>{project.accepted_count} принято</span>
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

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}
