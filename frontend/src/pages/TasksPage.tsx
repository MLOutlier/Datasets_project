import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { KanbanBoard } from "../components/KanbanBoard";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { tasksAPI } from "../services/api";
import { useAuthStore } from "../store";
import { Task, TaskStatus } from "../types";

const STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "completed", "rejected"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  review: "Validation",
  completed: "Completed",
  rejected: "Rejected",
};

export function TasksPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [filter, setFilter] = React.useState<TaskStatus | "all">("all");

  if (user?.role === "annotator") {
    return (
      <div className="space-y-6">
        <div className="card p-8 text-center">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Annotation tasks moved</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            CV assignments now live in the Labeling section.
          </p>
          <Link to="/labeling" className="btn-primary mt-5 inline-block">
            Open labeling queue
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
    for (const task of tasks) map[task.status]++;
    return map;
  }, [tasks]);

  const totalTasks = tasks.length;
  const completedTasks = stats.completed;
  const progressPercentage = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="border-b border-gray-200 pb-6 dark:border-gray-700">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Tasks</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Legacy generic task board. CV work is driven by project assignments and validation queues.
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{totalTasks}</div>
            <div className="text-xs text-gray-500">total tasks</div>
          </div>
        </div>

        <div className="card py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Completion progress</span>
            <span className="text-sm font-bold text-primary-600">{progressPercentage.toFixed(1)}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-gray-200">
            <div className="h-full bg-gradient-to-r from-primary-500 to-primary-600 transition-all duration-500" style={{ width: `${progressPercentage}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-gray-500">
            {STATUSES.map((status) => (
              <span key={status}>{STATUS_LABELS[status]}: {stats[status]}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter("all")}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
            filter === "all" ? "bg-gradient-primary text-white shadow-md" : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800"
          }`}
        >
          All ({totalTasks})
        </button>
        {STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
              filter === status ? "bg-gradient-primary text-white shadow-md" : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800"
            }`}
          >
            {STATUS_LABELS[status]} ({stats[status]})
          </button>
        ))}
      </div>

      {tasksQuery.isLoading ? (
        <div className="flex flex-col items-center justify-center py-12">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-sm text-gray-600">Loading tasks...</p>
        </div>
      ) : tasksQuery.isError ? (
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-sm font-medium text-red-600">Failed to load tasks</p>
          <p className="mt-2 text-xs text-gray-500">Check the backend connection.</p>
        </div>
      ) : (
        <KanbanBoard tasks={tasks} onStatusChange={(taskId, newStatus) => updateMutation.mutate({ id: taskId, status: newStatus })} />
      )}
    </div>
  );
}
