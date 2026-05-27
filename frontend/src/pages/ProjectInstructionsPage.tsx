import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";

function isHtmlFile(name?: string, uri?: string) {
  const value = `${name || ""} ${uri || ""}`.toLowerCase();
  return value.includes(".html") || value.includes(".htm");
}

export default function ProjectInstructionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsAPI.get(projectId!),
    enabled: !!projectId,
  });

  if (projectQuery.isLoading) return <LoadingSpinner />;
  if (projectQuery.isError || !projectQuery.data) {
    return <div className="card text-sm text-red-600">Instruction is not available.</div>;
  }

  const project = projectQuery.data;
  const fileUri = project.instructions_file_uri || "";
  const fileName = project.instructions_file_name || "instruction";
  const html = isHtmlFile(fileName, fileUri);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Project instruction</h1>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{project.title}</div>
        </div>
        <Link className="btn-secondary" to={`/projects/${project.id}`}>
          Back to project
        </Link>
      </div>

      {html && fileUri ? (
        <iframe
          title={fileName}
          src={fileUri}
          sandbox=""
          className="h-[calc(100vh-180px)] w-full rounded-lg border border-gray-200 bg-white dark:border-gray-800"
        />
      ) : fileUri ? (
        <div className="card">
          <a className="text-blue-600 hover:underline dark:text-blue-400" href={fileUri} target="_blank" rel="noreferrer">
            Open {fileName}
          </a>
        </div>
      ) : (
        <div className="card whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
          {project.instructions || "No instruction has been uploaded yet."}
        </div>
      )}
    </div>
  );
}
