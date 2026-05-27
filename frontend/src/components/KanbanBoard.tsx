/**
 * Kanban-доска для управления задачами
 * - Drag-n-Drop между колонками
 * - Статистика по колонкам
 */

import React from "react";
import { Task, TaskStatus } from "../types";

const STATUS_CONFIG: Record<TaskStatus, { label: string; icon: string; color: string }> = {
  pending: { label: "Ожидает", icon: "📝", color: "bg-gray-500" },
  in_progress: { label: "В работе", icon: "⏳", color: "bg-yellow-500" },
  review: { label: "На проверке", icon: "👀", color: "bg-blue-500" },
  completed: { label: "Завершено", icon: "✅", color: "bg-green-500" },
  rejected: { label: "Отклонено", icon: "❌", color: "bg-red-500" },
};

const STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "completed", "rejected"];

function TaskCard({ task, onDragStart }: { task: Task; onDragStart: (id: string) => void }) {
  const [isDragging, setIsDragging] = React.useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
    onDragStart(task.id);
  };

  const difficultyColor = task.difficulty_score < 0.3 ? "text-green-600" : task.difficulty_score < 0.7 ? "text-yellow-600" : "text-red-600";

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setIsDragging(false)}
      className={`group cursor-grab active:cursor-grabbing rounded-lg bg-white dark:bg-gray-900 p-3 shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-all duration-200 ${isDragging ? "opacity-50 scale-95" : "opacity-100"}`}
    >
      <div className="mb-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2">
          {task.title || `Задача #${task.id.slice(0, 6)}`}
        </h4>
      </div>
      <div className="flex items-center justify-between mb-2">
        <code className="text-[10px] font-mono text-gray-500 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">{task.id.slice(0, 8)}...</code>
        <span className={`text-[10px] font-medium ${difficultyColor}`}>{(task.difficulty_score * 100).toFixed(0)}%</span>
      </div>
      <div className="text-[11px] text-gray-500 mb-0.5">Датасет</div>
      <code className="text-xs font-mono text-gray-700 dark:text-gray-300 bg-primary-50 dark:bg-primary-900/20 px-1.5 py-0.5 rounded block truncate">
        {task.dataset_id.slice(0, 12)}...
      </code>
      <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-800 mt-2">
        <span className="text-[10px] text-gray-400">{task.created_at ? new Date(task.created_at).toLocaleDateString("ru-RU") : "—"}</span>
      </div>
    </div>
  );
}

function KanbanColumn({
  status,
  tasks,
  onDropTask,
  onDragOver,
  isDragOver,
}: {
  status: TaskStatus;
  tasks: Task[];
  onDropTask: (taskId: string, status: TaskStatus) => void;
  onDragOver: (status: TaskStatus) => void;
  isDragOver: boolean;
}) {
  const config = STATUS_CONFIG[status];

  return (
    <div
      className={`flex flex-col rounded-xl bg-gray-100 dark:bg-gray-800/50 transition-all duration-200 ${isDragOver ? "ring-2 ring-primary-500 ring-offset-2" : ""}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(status); }}
      onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id) onDropTask(id, status); }}
    >
      <div className="sticky top-0 flex items-center justify-between gap-2 rounded-t-xl bg-gray-200 dark:bg-gray-800 px-3 py-2 border-b border-gray-300 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-lg">{config.icon}</span>
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{config.label}</span>
        </div>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white dark:bg-gray-700 text-xs font-bold text-gray-700 dark:text-gray-300 shadow-sm">
          {tasks.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 p-2 overflow-y-auto min-h-[200px]">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500 border-2 border-dashed border-gray-300 rounded-lg">
            <span className="text-2xl mb-2">📭</span>
            <span className="text-xs">Нет задач</span>
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} onDragStart={() => {}} />)
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({ tasks, onStatusChange }: { tasks: Task[]; onStatusChange: (taskId: string, newStatus: TaskStatus) => void }) {
  const [dragOverColumn, setDragOverColumn] = React.useState<TaskStatus | null>(null);

  const tasksByStatus = React.useMemo(() => {
    const map: Record<TaskStatus, Task[]> = { pending: [], in_progress: [], review: [], completed: [], rejected: [] };
    for (const task of tasks) map[task.status].push(task);
    return map;
  }, [tasks]);

  return (
    <div className="grid gap-4 lg:grid-cols-5 min-h-[calc(100vh-12rem)]">
      {STATUSES.map((status) => (
        <KanbanColumn
          key={status}
          status={status}
          tasks={tasksByStatus[status]}
          onDropTask={onStatusChange}
          onDragOver={setDragOverColumn}
          isDragOver={dragOverColumn === status}
        />
      ))}
    </div>
  );
}
