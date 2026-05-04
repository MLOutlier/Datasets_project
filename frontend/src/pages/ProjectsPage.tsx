import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

export default function ProjectsPage() {
  const user = useAuthStore((s) => s.user);
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsAPI.list({ limit: 100, offset: 0 }),
  });

  const projects = projectsQuery.data?.items ?? [];
  const canCreate = user?.role === "customer" || user?.role === "admin";

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
            <Link key={project.id} to={`/projects/${project.id}`} className="card card-hover block h-full">
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
          ))}
        </div>
      )}
    </div>
  );
}
