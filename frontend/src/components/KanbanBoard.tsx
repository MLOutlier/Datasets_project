import React from "react";
import { Task, TaskStatus } from "../types";

const STATUS_CONFIG: Record<TaskStatus, { label: string; icon: string; color: string }> = {
  pending: { label: "Pending", icon: "P", color: "bg-gray-500" },
  in_progress: { label: "In progress", icon: "W", color: "bg-yellow-500" },
  review: { label: "Validation", icon: "V", color: "bg-blue-500" },
  completed: { label: "Completed", icon: "C", color: "bg-green-500" },
  rejected: { label: "Rejected", icon: "R", color: "bg-red-500" },
};

const STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "completed", "rejected"];

function TaskCard({ task, onDragStart }: { task: Task; onDragStart: (id: string) => void }) {
  const [isDragging, setIsDragging] = React.useState(false);

  const handleDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
    onDragStart(task.id);
  };

  const difficultyColor = task.difficulty_score < 0.3 ? "text-green-600" : task.difficulty_score < 0.7 ? "text-yellow-600" : "text-red-600";

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => setIsDragging(false)}
      className={`group cursor-grab rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-all duration-200 active:cursor-grabbing dark:border-gray-700 dark:bg-gray-900 ${isDragging ? "scale-95 opacity-50" : "opacity-100 hover:shadow-md"}`}
    >
      <h4 className="mb-2 line-clamp-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {task.title || `Task #${task.id.slice(0, 6)}`}
      </h4>
      <div className="mb-2 flex items-center justify-between">
        <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800">{task.id.slice(0, 8)}...</code>
        <span className={`text-[10px] font-medium ${difficultyColor}`}>{(task.difficulty_score * 100).toFixed(0)}%</span>
      </div>
      <div className="mb-0.5 text-[11px] text-gray-500">Dataset</div>
      <code className="block truncate rounded bg-primary-50 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-primary-900/20 dark:text-gray-300">
        {task.dataset_id.slice(0, 12)}...
      </code>
      <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2 dark:border-gray-800">
        <span className="text-[10px] text-gray-400">{task.created_at ? new Date(task.created_at).toLocaleDateString() : "-"}</span>
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
      className={`flex flex-col rounded-xl bg-gray-100 transition-all duration-200 dark:bg-gray-800/50 ${isDragOver ? "ring-2 ring-primary-500 ring-offset-2" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver(status);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData("text/plain");
        if (id) onDropTask(id, status);
      }}
    >
      <div className="sticky top-0 flex items-center justify-between gap-2 rounded-t-xl border-b border-gray-300 bg-gray-200 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded text-xs font-semibold text-white ${config.color}`}>{config.icon}</span>
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{config.label}</span>
        </div>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-bold text-gray-700 shadow-sm dark:bg-gray-700 dark:text-gray-300">
          {tasks.length}
        </span>
      </div>
      <div className="min-h-[200px] flex-1 space-y-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 py-8 text-gray-500">
            <span className="text-xs">No tasks</span>
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
    <div className="grid min-h-[calc(100vh-12rem)] gap-4 lg:grid-cols-5">
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
