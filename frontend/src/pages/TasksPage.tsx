/**
 * Страница управления задачами с Kanban-доской
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { tasksAPI } from "../services/api";
import { Task, TaskStatus } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { KanbanBoard } from "../components/KanbanBoard";
import { useAuthStore } from "../store";

const STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "completed", "rejected"];
const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "📝",
  in_progress: "⏳",
  review: "👀",
  completed: "✅",
  rejected: "❌",
};
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Ожидает",
  in_progress: "В работе",
  review: "На проверке",
  completed: "Завершено",
  rejected: "Отклонено",
};

export function TasksPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [filter, setFilter] = React.useState<TaskStatus | "all">("all");

  if (user?.role === "annotator") {
    return (
      <div className="space-y-6">
        <div className="card p-8 text-center">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">📦 Задачи разметки перенесены</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Задачи CV-разметки теперь находятся в разделе <span className="font-medium">«Разметка»</span>.
          </p>
          <Link to="/labeling" className="btn-primary mt-5 inline-block">
            🏷️ Перейти к разметке
          </Link>
        </div>
      </div>
    );
  }

  const tasksQuery = useQuery({
    queryKey: ["tasks", filter],
    queryFn: () => tasksAPI.list({ limit: 100, offset: 0, status: filter === "all" ? undefined : filter }),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; status: TaskStatus }) => tasksAPI.update(vars.id, { status: vars.status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const tasks: Task[] = (tasksQuery.data as any)?.items ?? [];

  const stats = React.useMemo(() => {
    const map: Record<TaskStatus, number> = { pending: 0, in_progress: 0, review: 0, completed: 0, rejected: 0 };
    for (const t of tasks) map[t.status]++;
    return map;
  }, [tasks]);

  const totalTasks = tasks.length;
  const completedTasks = stats.completed;
  const progressPercentage = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="pb-6 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">✅ Задачи</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Управление задачами разметки данных</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{totalTasks}</div>
            <div className="text-xs text-gray-500">всего задач</div>
          </div>
        </div>

        {/* Прогресс */}
        <div className="card py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">📊 Прогресс выполнения</span>
            <span className="text-sm font-bold text-primary-600">{progressPercentage.toFixed(1)}%</span>
          </div>
          <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-primary-500 to-primary-600 transition-all duration-500" style={{ width: `${progressPercentage}%` }} />
          </div>
          <div className="flex justify-between mt-2 text-xs text-gray-500">
            <span>📝 {stats.pending} ожидает</span>
            <span>⏳ {stats.in_progress} в работе</span>
            <span>👀 {stats.review} на проверке</span>
            <span>✅ {stats.completed} завершено</span>
            <span>❌ {stats.rejected} отклонено</span>
          </div>
        </div>
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter("all")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
            filter === "all" ? "bg-gradient-primary text-white shadow-md" : "bg-white dark:bg-gray-800 text-gray-700 border border-gray-300 hover:bg-gray-50"
          }`}
        >
          📋 Все ({totalTasks})
        </button>
        {STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-all duration-200 ${
              filter === status ? "bg-gradient-primary text-white shadow-md" : "bg-white dark:bg-gray-800 text-gray-700 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            {STATUS_ICONS[status]} {STATUS_LABELS[status]} ({stats[status]})
          </button>
        ))}
      </div>

      {/* Kanban-доска */}
      {tasksQuery.isLoading ? (
        <div className="flex flex-col items-center justify-center py-12"><LoadingSpinner size="lg" /><p className="mt-4 text-sm text-gray-600">Загрузка задач...</p></div>
      ) : tasksQuery.isError ? (
        <div className="flex flex-col items-center justify-center py-12">
          <svg className="w-16 h-16 text-red-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-medium text-red-600">Не удалось загрузить задачи</p>
          <p className="text-xs text-gray-500 mt-2">Проверьте подключение к серверу</p>
        </div>
      ) : (
        <KanbanBoard tasks={tasks} onStatusChange={(taskId, newStatus) => updateMutation.mutate({ id: taskId, status: newStatus })} />
      )}

      {/* Подсказка */}
      <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border-blue-200">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-900">💡 Совет: перетаскивайте задачи между колонками</p>
            <p className="text-xs text-blue-700 mt-1">Просто перетащите задачу на нужную колонку, чтобы изменить её статус. Изменения сохранятся автоматически.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
