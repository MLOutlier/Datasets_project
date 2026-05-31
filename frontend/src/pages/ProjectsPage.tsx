import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { statusLabel, taskTypeLabel } from "../lib/projectDisplay";
import { projectsAPI } from "../services/api";
import { useAuthStore } from "../store";

const STATUS_OPTIONS = ["active", "open", "paused", "closed"];
const TASK_TYPE_OPTIONS = [
  "video_annotation",
  "video_interval_validation",
  "bbox_annotation",
  "bbox_validation",
  "text_annotation",
  "image_annotation",
  "classification",
  "comparison",
];
const ANNOTATION_TYPE_OPTIONS = ["bbox", "generic"];
const PAGE_SIZE = 25;

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

export default function ProjectsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [taskType, setTaskType] = useState("");
  const [annotationType, setAnnotationType] = useState("");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [search, status, taskType, annotationType]);

  const listParams = {
    limit: PAGE_SIZE,
    offset,
    search: search.trim() || undefined,
    status: status || undefined,
    task_type: taskType || undefined,
    annotation_type: annotationType || undefined,
  };

  const projectsQuery = useQuery({
    queryKey: ["projects", listParams],
    queryFn: () => projectsAPI.list(listParams),
  });

  const projects = projectsQuery.data?.items ?? [];
  const total = projectsQuery.data?.total ?? projects.length;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const canCreate = user?.role === "customer" || user?.role === "admin";
  const totals = useMemo(
    () => ({
      all: total,
      active: projects.filter((project) => project.status === "active").length,
      closed: projects.filter((project) => project.status === "closed").length,
      cv: projects.filter((project) => project.project_type === "cv").length,
    }),
    [projects, total],
  );

  const deleteProjectMutation = useMutation({
    mutationFn: (projectId: string) => projectsAPI.delete(projectId),
    onSuccess: async () => {
      setDeleteError(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: async (err: unknown) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (isAxiosError(err) && err.response?.status === 404) {
        setDeleteError("Project is already unavailable. The list was refreshed.");
        return;
      }
      setDeleteError("Could not delete the project. Check permissions and try again.");
    },
  });

  const handleDeleteProject = (projectId: string, projectTitle: string) => {
    const confirmed = window.confirm(`Delete project "${projectTitle}"? This action cannot be undone.`);
    if (!confirmed) return;
    deleteProjectMutation.mutate(projectId);
  };

  return (
    <div className="space-y-6">
      <div className="sticky top-16 z-20 -mx-2 space-y-4 bg-gray-50/95 px-2 py-2 backdrop-blur dark:bg-gray-900/95">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Projects</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {user?.role === "annotator" ? "Assigned annotation projects" : "Create and monitor dataset projects"}
            </p>
          </div>
          {canCreate ? (
            <Link to="/projects/create" className="btn-primary">
              New project
            </Link>
          ) : null}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <input className="input-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title or description" />
            <select className="input-field" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}
            </select>
            <select className="input-field" value={taskType} onChange={(event) => setTaskType(event.target.value)}>
              <option value="">All task types</option>
              {TASK_TYPE_OPTIONS.map((item) => <option key={item} value={item}>{taskTypeLabel(item)}</option>)}
            </select>
            <select className="input-field" value={annotationType} onChange={(event) => setAnnotationType(event.target.value)}>
              <option value="">All annotation types</option>
              {ANNOTATION_TYPE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="flex min-h-[86px] flex-col justify-center rounded-lg border border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="whitespace-nowrap text-sm leading-5 text-gray-500 dark:text-gray-400">Total</div>
          <div className="mt-2 text-2xl font-semibold leading-none text-gray-900 dark:text-white">{totals.all}</div>
        </div>
        <div className="flex min-h-[86px] flex-col justify-center rounded-lg border border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="whitespace-nowrap text-sm leading-5 text-gray-500 dark:text-gray-400">Active on page</div>
          <div className="mt-2 text-2xl font-semibold leading-none text-gray-900 dark:text-white">{totals.active}</div>
        </div>
        <div className="flex min-h-[86px] flex-col justify-center rounded-lg border border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="whitespace-nowrap text-sm leading-5 text-gray-500 dark:text-gray-400">CV on page</div>
          <div className="mt-2 text-2xl font-semibold leading-none text-gray-900 dark:text-white">{totals.cv}</div>
        </div>
        <div className="flex min-h-[86px] flex-col justify-center rounded-lg border border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-950">
          <div className="whitespace-nowrap text-sm leading-5 text-gray-500 dark:text-gray-400">Closed on page</div>
          <div className="mt-2 text-2xl font-semibold leading-none text-gray-900 dark:text-white">{totals.closed}</div>
        </div>
      </div>

      {deleteError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          {deleteError}
        </div>
      ) : null}

      {projectsQuery.isLoading ? (
        <div className="card flex flex-col items-center justify-center p-10">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Loading projects...</p>
        </div>
      ) : projects.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">No projects found</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {canCreate ? "Create a project or adjust filters." : "There are no available projects yet."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="max-h-[calc(100vh-360px)] min-h-[320px] overflow-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead className="sticky top-0 z-10 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3">Project</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Labels</th>
                  <th className="px-4 py-3">Executors</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {projects.map((project) => (
                  <tr key={project.id} className="hover:bg-gray-50 dark:hover:bg-gray-900">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{project.title}</div>
                      <div className="mt-1 max-w-md truncate text-xs text-gray-500 dark:text-gray-400">{project.description || "No description"}</div>
                    </td>
                    <td className="px-4 py-3"><span className="badge badge-success">{statusLabel(project.status)}</span></td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      <div>{taskTypeLabel(project.task_type)}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{project.annotation_type} / {project.widget_type}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{project.label_schema.length}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      {project.available_executor_count ?? project.allowed_annotator_count ?? project.allowed_annotator_ids?.length ?? 0}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{formatDate(project.updated_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Link className="btn-secondary" to={`/projects/${project.id}`}>Open</Link>
                        {canCreate ? (
                          <button
                            type="button"
                            className="rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-300 dark:hover:bg-red-950/40"
                            disabled={deleteProjectMutation.isPending}
                            onClick={() => handleDeleteProject(project.id, project.title)}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex min-h-[68px] flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300">
            <div className="min-w-0 shrink break-words">Showing {pageStart}-{pageEnd} of {total}</div>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn-secondary" disabled={offset === 0 || projectsQuery.isFetching} onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}>
                Previous
              </button>
              <button type="button" className="btn-secondary" disabled={offset + PAGE_SIZE >= total || projectsQuery.isFetching} onClick={() => setOffset((current) => current + PAGE_SIZE)}>
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
