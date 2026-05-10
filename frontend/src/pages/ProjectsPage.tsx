import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { projectsAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

export default function ProjectsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsAPI.list({ limit: 100, offset: 0 }),
  });

  const projects = projectsQuery.data?.items ?? [];
  const canCreate = user?.role === "customer" || user?.role === "admin";
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
      setDeleteError("Could not delete project. Please try again or check permissions.");
    },
  });

  const handleDeleteProject = (projectId: string, projectTitle: string) => {
    const confirmed = window.confirm(`Delete project "${projectTitle}"? This cannot be undone.`);
    if (!confirmed) return;
    deleteProjectMutation.mutate(projectId);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Проекты</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {user?.role === "annotator" ? "Assigned CV projects ready for annotation" : user?.role === "reviewer" ? "Projects waiting for review decisions" : "Create and monitor dataset production workflows"}
          </p>
        </div>
        {canCreate ? (
          <Link to="/projects/create" className="btn-primary">
            Новый проект
          </Link>
        ) : null}
      </div>

      {deleteError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          {deleteError}
        </div>
      ) : null}

      {projectsQuery.isLoading ? (
        <div className="card p-10 flex flex-col items-center justify-center">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Loading projects...</p>
        </div>
      ) : projects.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">No projects yet</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {canCreate ? "Create a project, upload images or videos, and generate annotation work." : "You are not a member of any active project yet."}
          </p>
          {canCreate ? (
            <Link to="/projects/create" className="btn-primary inline-block mt-5">
              Создать проект
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <div key={project.id} className="card card-hover flex h-full flex-col">
              <Link to={`/projects/${project.id}`} className="block flex-1">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{project.project_type} / {project.annotation_type}</div>
                    <h2 className="mt-2 text-xl font-semibold text-gray-900 dark:text-white">{project.title}</h2>
                  </div>
                  <span className="badge badge-success">{project.status}</span>
                </div>
                <p className="mt-3 line-clamp-3 text-sm text-gray-600 dark:text-gray-400">{project.description || "No description yet"}</p>
                <div className="mt-5 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>{project.label_schema.length} labels</span>
                  <span>{project.assignments_per_task} annotators per frame</span>
                  <span>{project.frame_interval_sec}s frame step</span>
                </div>
              </Link>
              {canCreate ? (
                <div className="mt-5 flex justify-end border-t border-gray-200 pt-4 dark:border-gray-700">
                  <button
                    type="button"
                    className="rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-300 dark:hover:bg-red-950/40"
                    disabled={deleteProjectMutation.isPending}
                    onClick={() => handleDeleteProject(project.id, project.title)}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
