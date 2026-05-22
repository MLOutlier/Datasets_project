import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { projectsAPI, workflowAPI, dawidSkeneAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";
import { getTaskFlowCopy, getTaskGroupLabel } from "../lib/taskFlowCopy";
import type { ProjectExportArtifact, ProjectExportArtifactName, ProjectExportFormat } from "../types";

function DawidSkeneQuality({ projectId }: { projectId: string }) {
  const qualityQuery = useQuery({
    queryKey: ["dawid-skene-quality", projectId],
    queryFn: () => dawidSkeneAPI.getProjectQuality(projectId),
    enabled: !!projectId,
  });

  if (qualityQuery.isLoading) return <LoadingSpinner />;
  if (qualityQuery.isError || !qualityQuery.data) {
    return (
      <div className="card">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
          Annotator quality (Dawid-Skene)
        </h2>
        <p className="mt-2 text-sm text-gray-500">
          Quality metrics will appear after cross-check reviews are created.
        </p>
      </div>
    );
  }

  const { annotators } = qualityQuery.data;

  return (
    <div className="card">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
        Annotator quality (Dawid-Skene)
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        EM-based probabilistic model. Accuracy and confusion matrix computed
        from cross-check consensus.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {annotators.map((a) => (
          <div
            key={a.user_id}
            className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="flex items-center justify-between">
              <div className="font-semibold text-gray-900 dark:text-white">
                {a.username}
              </div>
              <div
                className={`text-sm font-bold ${
                  a.accuracy >= 0.7
                    ? "text-green-600"
                    : a.accuracy >= 0.5
                    ? "text-yellow-600"
                    : "text-red-600"
                }`}
              >
                Acc: {(a.accuracy * 100).toFixed(0)}%
              </div>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded bg-white p-2 dark:bg-gray-900">
                <div className="text-gray-500">F1-score</div>
                <div className="font-bold text-gray-900 dark:text-white">
                  {a.f1?.toFixed(3) ?? "—"}
                </div>
              </div>
              <div className="rounded bg-white p-2 dark:bg-gray-900">
                <div className="text-gray-500">Error rate</div>
                <div className="font-bold text-gray-900 dark:text-white">
                  {(a.error_rate * 100).toFixed(1)}%
                </div>
              </div>
              <div className="rounded bg-white p-2 dark:bg-gray-900">
                <div className="text-gray-500">Rating</div>
                <div className="font-bold text-gray-900 dark:text-white">
                  {a.rating?.toFixed(2) ?? "—"}
                </div>
              </div>
            </div>

            {a.confusion_matrix && Object.keys(a.confusion_matrix).length > 0 ? (
              <div className="mt-3">
                <div className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
                  Confusion matrix (true → predicted):
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr>
                      <th className="text-left text-gray-500">True ↓ Pred →</th>
                      {Object.keys(Object.values(a.confusion_matrix)[0] || {}).map((label) => (
                        <th key={label} className="text-center text-gray-500">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(a.confusion_matrix).map(([trueLabel, row]) => (
                      <tr key={trueLabel}>
                        <td className="font-medium text-gray-700 dark:text-gray-300">
                          {trueLabel}
                        </td>
                        {Object.entries(row).map(([predLabel, prob]) => (
                          <td
                            key={predLabel}
                            className={`text-center font-mono ${
                              trueLabel === predLabel
                                ? Number(prob) >= 0.7
                                  ? "text-green-600"
                                  : "text-yellow-600"
                                : Number(prob) > 0.3
                                ? "text-red-600"
                                : "text-gray-400"
                            }`}
                          >
                            {((prob as number) * 100).toFixed(0)}%
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {a.rating_history && a.rating_history.length > 0 ? (
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Last {a.rating_history.length} tasks:{" "}
                {a.rating_history.slice(0, 3).map((h, i) => (
                  <span key={i} className="ml-1">
                    {h.rating_delta >= 0 ? "↑" : "↓"}
                    {Math.abs(h.rating_delta).toFixed(2)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [exportPayload, setExportPayload] = useState<string | null>(null);
  const [instructionFile, setInstructionFile] = useState<File | null>(null);
  const [instructionUploadError, setInstructionUploadError] = useState<string | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ProjectExportFormat>("both");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [genericTasksInput, setGenericTasksInput] = useState("");
  const [genericTasksFile, setGenericTasksFile] = useState<File | null>(null);
  const [genericTasksError, setGenericTasksError] = useState<string | null>(null);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsAPI.get(projectId!),
    enabled: !!projectId,
  });

  const overviewQuery = useQuery({
    queryKey: ["project-overview", projectId],
    queryFn: () => workflowAPI.overview(projectId!),
    enabled: !!projectId,
  });
  const securityEventsQuery = useQuery({
    queryKey: ["project-security-events", projectId],
    queryFn: () => workflowAPI.securityEvents(projectId!),
    enabled: !!projectId,
  });
  const goldenCandidatesQuery = useQuery({
    queryKey: ["project-golden-candidates", projectId],
    queryFn: () => workflowAPI.goldenCandidates(projectId!),
    enabled: !!projectId,
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!projectId || uploadQueue.length === 0) {
        return null;
      }
      let currentImportId = activeImportId;
      let latest = null;
      for (const file of uploadQueue) {
        latest = await workflowAPI.upload(projectId, file, currentImportId);
        currentImportId = latest.import_id;
      }
      return latest;
    },
    onSuccess: (result) => {
      if (result?.import_id) {
        setActiveImportId(result.import_id);
      }
      setUploadQueue([]);
      setUploadError(result?.asset_status === "failed" ? result.error_message || "Video was uploaded, but processing failed." : null);
      queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
    onError: (err: any) => {
      setUploadError(err.response?.data?.detail || err.response?.data?.error || err.message || "Upload failed");
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const importId = activeImportId || String(overviewQuery.data?.imports?.latest_ready_import_id || "");
      if (!projectId || !importId) {
        throw new Error("Nothing to finalize");
      }
      return workflowAPI.finalize(projectId, importId);
    },
    onSuccess: () => {
      setFinalizeError(null);
      queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
    onError: (err: any) => {
      setFinalizeError(err?.response?.data?.detail || err?.response?.data?.error || "Finalize failed");
    },
  });

  const exportMutation = useMutation({
    mutationFn: async ({ artifact, format }: { artifact: ProjectExportArtifactName | string; format: ProjectExportFormat }) =>
      workflowAPI.export(projectId!, format, artifact),
    onSuccess: (payload) => {
      setExportPayload(JSON.stringify(payload, null, 2));
    },
    onError: (err: any) => {
      setArchiveError(err?.response?.data?.detail || err?.message || "Export failed");
    },
  });

  const exportArchiveMutation = useMutation({
    mutationFn: async ({ artifact, format }: { artifact: ProjectExportArtifactName | string; format: ProjectExportFormat }) => {
      const blob = await workflowAPI.exportArchive(projectId!, format, artifact);
      return { blob, artifact, format };
    },
    onSuccess: ({ blob, artifact, format }) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `project-${projectId}-${artifact}-${format}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setArchiveError(null);
    },
    onError: (err: any) => {
      setArchiveError(err?.response?.data?.detail || err?.message || "Archive export failed");
    },
  });

  const syncWorkflowMutation = useMutation({
    mutationFn: async () => workflowAPI.sync(projectId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-golden-candidates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-security-events", projectId] });
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("Project id missing");
      await projectsAPI.delete(projectId);
    },
    onSuccess: async () => {
      setDeleteError(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
    },
    onError: async (err: any) => {
      if (isAxiosError(err) && err.response?.status === 404) {
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
        navigate("/projects");
        return;
      }
      setDeleteError(err?.response?.data?.detail || err?.message || "Failed to delete project");
    },
  });

  const promoteGoldenMutation = useMutation({
    mutationFn: async ({ goldenFrameId, reviewNotes }: { goldenFrameId: string; reviewNotes?: string }) =>
      workflowAPI.promoteGoldenCandidate(projectId!, goldenFrameId, reviewNotes),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-golden-candidates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-security-events", projectId] });
    },
  });
  const genericTasksQuery = useQuery({
    queryKey: ["project-generic-tasks", projectId],
    queryFn: () => projectsAPI.genericTasks(projectId!),
    enabled: !!projectId && ["text_annotation", "image_annotation", "classification", "comparison"].includes(String(projectQuery.data?.task_type || "")),
  });

  const retireGoldenMutation = useMutation({
    mutationFn: async ({ goldenFrameId, reviewNotes }: { goldenFrameId: string; reviewNotes?: string }) =>
      workflowAPI.retireGoldenCandidate(projectId!, goldenFrameId, reviewNotes),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-golden-candidates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-security-events", projectId] });
    },
  });

  const instructionUploadMutation = useMutation({
    mutationFn: async () => {
      if (!projectId || !instructionFile) {
        throw new Error("Выберите файл инструкции");
      }
      return projectsAPI.uploadInstructions(projectId, instructionFile);
    },
    onSuccess: async () => {
      setInstructionFile(null);
      setInstructionUploadError(null);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: any) => {
      setInstructionUploadError(err?.response?.data?.detail || err?.response?.data?.error || err?.message || "Не удалось загрузить инструкцию");
    },
  });

  const createGenericTasksMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("Project id missing");
      if (genericTasksFile) {
        const formData = new FormData();
        formData.append("file", genericTasksFile);
        return projectsAPI.createGenericTasks(projectId, formData);
      }
      return projectsAPI.createGenericTasks(projectId, { items: genericTasksInput });
    },
    onSuccess: async () => {
      setGenericTasksInput("");
      setGenericTasksFile(null);
      setGenericTasksError(null);
      await queryClient.invalidateQueries({ queryKey: ["project-generic-tasks", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
    onError: (err: any) => {
      setGenericTasksError(err?.response?.data?.detail || err?.message || "Не удалось создать generic-задачи");
    },
  });

  const overview = overviewQuery.data;
  const taskType = String(projectQuery.data?.task_type || "bbox_annotation");
  const taskCopy = getTaskFlowCopy(taskType);
  const isGenericTask = ["text_annotation", "image_annotation", "classification", "comparison"].includes(taskType);
  const isValidationTask = ["video_interval_validation", "bbox_validation"].includes(taskType);
  const canUploadMedia = ["bbox_annotation", "video_annotation", "image_annotation"].includes(taskType);
  const lastUploadPreview = uploadMutation.data?.preview;
  const readyImportId = activeImportId || String(overview?.imports?.latest_ready_import_id || "");
  const hasVideoAssets = Array.isArray(overview?.imports?.video_asset_ids) && overview.imports.video_asset_ids.length > 0;
  const overviewAny = overview as any;
  const genericTotal = Number(overviewAny?.generic_tasks?.total || genericTasksQuery.data?.summary?.total || 0);
  const genericCompleted = Number(overviewAny?.generic_tasks?.completed || genericTasksQuery.data?.summary?.completed || 0);
  const totalWorkItems = Number(overview?.work_items?.total || 0);
  const completedWorkItems = Number(overview?.work_items?.completed || 0);
  const approvedExportItems = isGenericTask ? genericCompleted : Number((overview?.work_items as any)?.validation_approved || 0);
  const validationPendingItems = Number((overview?.work_items as any)?.validation_pending || 0);
  const validationDisputedItems = Number((overview?.work_items as any)?.validation_disputed || 0);
  const insufficientAnnotatorItems = Number((overview?.work_items as any)?.insufficient_annotators || 0);
  const insufficientValidatorItems = Number((overview?.work_items as any)?.insufficient_validators || 0);
  const exportTotalItems = isGenericTask ? genericTotal : totalWorkItems;
  const exportBlockedItems = Math.max(0, exportTotalItems - approvedExportItems);
  const exportReadyPercent = exportTotalItems > 0 ? Math.round((approvedExportItems / exportTotalItems) * 100) : 0;
  const exportReady = approvedExportItems > 0;
  const backendExportArtifacts = Array.isArray(overview?.export?.artifacts) ? overview.export.artifacts : [];
  const exportArtifacts: ProjectExportArtifact[] = isGenericTask
    ? [
        {
          artifact: "validated_dataset",
          title: "Ответы проекта",
          ready: genericCompleted > 0,
          items_count: genericCompleted,
          quality_level: "project_result",
          validated: false,
          message: genericCompleted > 0 ? "" : "Экспорт станет содержательным после появления хотя бы одного завершенного задания.",
          formats: ["json", "jsonl", "csv", "both"],
        },
      ]
    : backendExportArtifacts;
  const exportArtifactFormat = (artifact: ProjectExportArtifact): ProjectExportFormat => {
    const formats = (artifact.formats || []) as string[];
    if (formats.includes(exportFormat)) return exportFormat;
    return "both";
  };
  const previewArtifact = (artifact: ProjectExportArtifact) => {
    setArchiveError(null);
    exportMutation.mutate({ artifact: artifact.artifact, format: exportArtifactFormat(artifact) });
  };
  const downloadArtifact = (artifact: ProjectExportArtifact) => {
    setArchiveError(null);
    exportArchiveMutation.mutate({ artifact: artifact.artifact, format: exportArtifactFormat(artifact) });
  };
  const goldenCandidates = goldenCandidatesQuery.data?.items ?? [];
  const goldenActiveCount = Number(goldenCandidatesQuery.data?.active_count ?? 0);
  const goldenCandidateCount = Number(goldenCandidatesQuery.data?.candidate_count ?? 0);
  const goldenRetiredCount = Number(goldenCandidatesQuery.data?.retired_count ?? 0);
  const bboxValidationAssigned = Number(overviewAny?.bbox_validation?.assigned || 0);
  const canDeleteProject = user?.role === "admin" || (user?.role === "customer" && projectQuery.data?.owner_id === user.id);
  const sourceSync = overview?.source_sync;
  const fallbackReadinessGates = [
    { label: "Импорт готов", ready: Number(overview?.imports?.ready || 0) > 0 || Number(overview?.imports?.finalized || 0) > 0 },
    { label: "Интервалы размечаются", ready: Number(overviewAny?.intervals?.total || 0) > 0 || Number(overviewAny?.intervals?.validation_assigned || 0) > 0 },
    { label: "Интервалы валидируются", ready: Number(overviewAny?.intervals?.validation_assigned || 0) > 0 || Number(overviewAny?.intervals?.approved || 0) > 0 },
    { label: "BBox-разметка доступна", ready: Number(overview?.work_items?.total || 0) > 0 },
    { label: "BBox-валидация идет", ready: Number(overviewAny?.bbox_validation?.assigned || 0) > 0 || Number((overview?.work_items as any)?.validation_pending || 0) > 0 },
    { label: "Экспорт доступен", ready: exportReady },
  ];
  const readinessGates = overview?.readiness_gates?.length ? overview.readiness_gates : fallbackReadinessGates;
  const nextAction = overview?.next_action;

  const completion = useMemo(() => {
    if (isGenericTask) return genericTotal > 0 ? Math.round((genericCompleted / genericTotal) * 100) : 0;
    return totalWorkItems > 0 ? Math.round((completedWorkItems / totalWorkItems) * 100) : 0;
  }, [completedWorkItems, genericCompleted, genericTotal, isGenericTask, totalWorkItems]);

  if (projectQuery.isLoading) {
    return <LoadingSpinner size="lg" />;
  }

  if (!projectQuery.data) {
    const canTryDeleteMissingProject = user?.role === "customer" || user?.role === "admin";
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          Проект не найден.
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/projects" className="btn-secondary">
            К проектам
          </Link>
          {canTryDeleteMissingProject && projectId ? (
            <button
              type="button"
              className="btn-secondary border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
              disabled={deleteProjectMutation.isPending}
              onClick={() => {
                if (window.confirm("Удалить недоступный проект из рабочего пространства?")) {
                  deleteProjectMutation.mutate();
                }
              }}
            >
              {deleteProjectMutation.isPending ? "Удаляем..." : "Удалить проект"}
            </button>
          ) : null}
        </div>
        {deleteError ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{deleteError}</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {projectQuery.data.project_type} / {getTaskGroupLabel(taskType)} / {taskCopy.projectTitle}
          </div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{projectQuery.data.title}</h1>
          <p className="mt-3 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{projectQuery.data.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to={`/projects/${projectId}/workflow`} className="btn-secondary">
            Настройка разметки
          </Link>
          {["video_annotation", "video_interval_validation"].includes(taskType) ? (
            <Link to={`/projects/${projectId}/intervals`} className="btn-secondary">
              Интервалы
            </Link>
          ) : null}
          <button className="btn-secondary" onClick={() => syncWorkflowMutation.mutate()} disabled={syncWorkflowMutation.isPending}>
            {syncWorkflowMutation.isPending ? "Синхронизируем..." : "Синхронизировать"}
          </button>
          {canDeleteProject ? (
            <button
              className="btn-secondary border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
              onClick={() => {
                if (window.confirm("Удалить проект и все связанные задания/разметки? Это действие нельзя отменить.")) {
                  deleteProjectMutation.mutate();
                }
              }}
              disabled={deleteProjectMutation.isPending}
            >
              {deleteProjectMutation.isPending ? "Удаляем..." : "Удалить проект"}
            </button>
          ) : null}
        </div>
      </div>
      {deleteError ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{deleteError}</div> : null}

      {nextAction ? (
        <div className={`rounded-lg border p-4 text-sm ${nextAction.severity === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : nextAction.severity === "warning" ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" : "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"}`}>
          Следующий шаг: {nextAction.route ? <Link className="font-semibold underline" to={nextAction.route}>{nextAction.label}</Link> : <span className="font-semibold">{nextAction.label}</span>}
        </div>
      ) : null}

      {projectQuery.data.source_project_id ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
          Источник данных: {projectQuery.data.source_project_title || projectQuery.data.source_project_id}. Нажмите Sync workflow, чтобы материализовать задания валидации из source-проекта.
        </div>
      ) : null}

      <div className={`rounded-lg border p-4 ${taskCopy.group === "video" ? "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100" : taskCopy.group === "bbox" ? "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "border-gray-200 bg-gray-50 text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{getTaskGroupLabel(taskType)}</div>
            <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{taskCopy.projectTitle}</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{taskCopy.projectDescription}</p>
          </div>
          {taskCopy.annotatorRoute ? (
            <Link to={taskCopy.annotatorRoute(projectId!)} className="btn-primary">
              {taskCopy.annotatorTitle}
            </Link>
          ) : null}
        </div>
      </div>

      {isGenericTask ? (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Задания для этого проекта</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Добавьте задания вручную или загрузите CSV с колонками title, prompt, input_ref, option_a, option_b.
              </p>
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Всего: {Number(genericTasksQuery.data?.summary?.total || 0)} · Ожидают: {Number(genericTasksQuery.data?.summary?.pending || 0)} · На проверке: {Number(genericTasksQuery.data?.summary?.review || 0)}
            </div>
          </div>
          <textarea
            className="input-field min-h-[120px]"
            value={genericTasksInput}
            onChange={(event) => setGenericTasksInput(event.target.value)}
            placeholder={taskType === "comparison" ? "Задание 1\nЗадание 2" : "Одна строка = одно задание"}
            disabled={!!genericTasksFile}
          />
          <input
            type="file"
            accept=".csv,.txt"
            onChange={(event) => setGenericTasksFile((event.target.files?.[0] as File | undefined) ?? null)}
            className="block w-full text-sm text-gray-600 dark:text-gray-300"
          />
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={createGenericTasksMutation.isPending || (!genericTasksInput.trim() && !genericTasksFile)}
              onClick={() => createGenericTasksMutation.mutate()}
            >
              {createGenericTasksMutation.isPending ? "Создаём..." : "Создать задания"}
            </button>
          </div>
          {genericTasksError ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{genericTasksError}</div> : null}
          {createGenericTasksMutation.data ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              Создано: {createGenericTasksMutation.data.created}, пропущено дублей: {createGenericTasksMutation.data.skipped}, всего: {createGenericTasksMutation.data.total}.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Кадры</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{Number(overview?.imports?.frames_total ?? 0)}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">{isGenericTask ? "Задания" : "Work items"}</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{isGenericTask ? genericTotal : totalWorkItems}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Готово к экспорту</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{approvedExportItems}/{exportTotalItems}</div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{exportReadyPercent}% готово</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Повторная разметка</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{Number(overview?.assignments?.disputed ?? 0)}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Завершение</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{completion}%</div>
        </div>
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Результаты проекта</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Каждый проект экспортирует собственный результат. Только проверенный датасет считается финальной выгрузкой для обучения модели.
            </p>
          </div>
          <select
            className="input-field w-auto"
            value={exportFormat}
            onChange={(event) => setExportFormat(event.target.value as ProjectExportFormat)}
          >
            <option value="both">Формат: все доступные</option>
            <option value="json">JSON</option>
            <option value="jsonl">JSONL</option>
            <option value="csv">CSV</option>
            {!isGenericTask ? <option value="coco">COCO</option> : null}
            {!isGenericTask ? <option value="yolo">YOLO</option> : null}
            {!isGenericTask ? <option value="voc">Pascal VOC</option> : null}
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4">
          {exportArtifacts.map((artifact) => {
            const isValidatedDataset = artifact.artifact === "validated_dataset";
            const effectiveFormat = exportArtifactFormat(artifact);
            return (
              <div
                key={artifact.artifact}
                className={`rounded-lg border p-4 ${
                  artifact.ready
                    ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
                    : "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-gray-900 dark:text-white">{artifact.title}</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {artifact.items_count} элементов · {artifact.quality_level}
                    </div>
                  </div>
                  <span className={`rounded px-2 py-1 text-xs font-medium ${artifact.ready ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100" : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>
                    {artifact.ready ? "Доступно" : "Ожидает"}
                  </span>
                </div>
                {!isValidatedDataset ? (
                  <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    Этот экспорт не является финальным проверенным датасетом.
                  </div>
                ) : null}
                {!artifact.ready && artifact.message ? (
                  <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">{artifact.message}</div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={exportMutation.isPending}
                    onClick={() => previewArtifact(artifact)}
                  >
                    {exportMutation.isPending ? "Готовим..." : `Preview ${effectiveFormat}`}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={exportArchiveMutation.isPending}
                    onClick={() => downloadArtifact(artifact)}
                  >
                    {exportArchiveMutation.isPending ? "ZIP..." : "Скачать ZIP"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {archiveError ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{archiveError}</div> : null}
      </div>

      <div className="card space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Готовность workflow</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Пользователь всегда видит, какой этап готов и что нужно сделать дальше.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {readinessGates.map((gate) => (
            <div key={gate.label} className={`rounded-lg border p-3 text-sm ${gate.ready ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400"}`}>
              <div className="font-medium">{gate.label}</div>
              <div className="mt-1 text-xs">{gate.ready ? "Готово" : "Ожидает"}</div>
            </div>
          ))}
        </div>
        {!exportReady ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {isGenericTask ? "Экспорт станет содержательным после появления хотя бы одного завершённого задания." : "Экспорт станет доступен после появления хотя бы одного подтверждённого кадра."}
            <div className="mt-2">
              Сейчас: ожидает bbox-валидации {validationPendingItems}, назначено пакетов валидации {bboxValidationAssigned}, спорных {validationDisputedItems}, нехватка исполнителей {insufficientAnnotatorItems}, нехватка валидаторов {insufficientValidatorItems}.
            </div>
            <div className="mt-2">
              Если это старый проект, нажмите Sync workflow: система попробует пересобрать очередь валидации по уже готовой разметке.
            </div>
          </div>
        ) : null}
        {syncWorkflowMutation.data?.sync ? (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
            Синхронизация завершена: bbox assignments {syncWorkflowMutation.data.sync.bbox_annotation_created ?? 0}, interval assignments {syncWorkflowMutation.data.sync.interval_annotation_created ?? 0}, evaluated {syncWorkflowMutation.data.sync.evaluated_items ?? 0}, bbox validation batches {syncWorkflowMutation.data.sync.bbox_validation_created ?? 0}.
          </div>
        ) : null}
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Golden pool</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Hidden quality-control set for annotation and validation. Active items are mixed into executor queues without visible labels.
            </p>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Active: {goldenActiveCount} · Candidates: {goldenCandidateCount} · Retired: {goldenRetiredCount}
          </div>
        </div>
        {goldenCandidatesQuery.isLoading ? (
          <LoadingSpinner size="sm" />
        ) : goldenCandidates.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {goldenCandidates.slice(0, 8).map((candidate) => {
              const boxes = ((candidate.reference_annotation as any)?.boxes ?? []) as Array<{ x: number; y: number; width: number; height: number; label: string }>;
              const width = Math.max(Number(candidate.width || 1), 1);
              const height = Math.max(Number(candidate.height || 1), 1);
              const statusTone =
                candidate.status === "active"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
                  : candidate.status === "retired"
                    ? "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200";
              return (
                <div key={candidate.golden_frame_id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-800 dark:bg-gray-950">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white">Frame {candidate.frame_number}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span className={`rounded px-2 py-0.5 ${statusTone}`}>{candidate.status || (candidate.is_active ? "active" : "candidate")}</span>
                        <span>score {Number(candidate.candidate_score || 0).toFixed(3)}</span>
                        <span>{candidate.candidate_source || "manual"}</span>
                      </div>
                    </div>
                    <a href={candidate.frame_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                      Open
                    </a>
                  </div>

                  <div className="mt-3 overflow-hidden rounded bg-black">
                    <div className="relative">
                      <img src={candidate.frame_url} alt={`Golden frame ${candidate.frame_number}`} className="block h-auto w-full" />
                      {boxes.map((box, index) => (
                        <div
                          key={`${candidate.golden_frame_id}-${index}`}
                          className="absolute border-2 border-emerald-400"
                          style={{
                            left: `${(Number(box.x || 0) / width) * 100}%`,
                            top: `${(Number(box.y || 0) / height) * 100}%`,
                            width: `${(Number(box.width || 0) / width) * 100}%`,
                            height: `${(Number(box.height || 0) / height) * 100}%`,
                          }}
                        >
                          <span className="absolute -top-5 left-0 rounded bg-black/80 px-1.5 py-0.5 text-[10px] text-white">{box.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600 dark:text-gray-400">
                    <div>Annotation pass: {Math.round(Number(candidate.stats?.annotation_pass_rate || 0) * 100)}% ({candidate.stats?.annotation_seen ?? 0})</div>
                    <div>Validation pass: {Math.round(Number(candidate.stats?.validation_pass_rate || 0) * 100)}% ({candidate.stats?.validation_seen ?? 0})</div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={promoteGoldenMutation.isPending || candidate.status === "active"}
                      onClick={() => {
                        const notes = window.prompt("Review notes for promotion", candidate.review_notes || "");
                        if (notes === null) return;
                        promoteGoldenMutation.mutate({ goldenFrameId: candidate.golden_frame_id, reviewNotes: notes });
                      }}
                    >
                      {candidate.status === "active" ? "Active" : "Promote"}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={retireGoldenMutation.isPending || candidate.status === "retired"}
                      onClick={() => {
                        const notes = window.prompt("Why retire this golden item?", candidate.review_notes || "");
                        if (notes === null) return;
                        retireGoldenMutation.mutate({ goldenFrameId: candidate.golden_frame_id, reviewNotes: notes });
                      }}
                    >
                      {candidate.status === "retired" ? "Retired" : "Retire"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
            No golden candidates yet.
          </div>
        )}
      </div>

      {isValidationTask ? (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Source project sync</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                This validation project materializes tasks from the selected source project. Re-running sync is safe and skips already imported source items.
              </p>
            </div>
            <button className="btn-primary" type="button" onClick={() => syncWorkflowMutation.mutate()} disabled={syncWorkflowMutation.isPending}>
              {syncWorkflowMutation.isPending ? "Syncing..." : "Sync source"}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="text-xs text-gray-500 dark:text-gray-400">Status</div>
              <div className="mt-1 font-semibold text-gray-900 dark:text-white">{sourceSync?.status || "not_synced"}</div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="text-xs text-gray-500 dark:text-gray-400">Created</div>
              <div className="mt-1 font-semibold text-gray-900 dark:text-white">{sourceSync?.created ?? 0}</div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="text-xs text-gray-500 dark:text-gray-400">Skipped</div>
              <div className="mt-1 font-semibold text-gray-900 dark:text-white">{sourceSync?.skipped ?? 0}</div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="text-xs text-gray-500 dark:text-gray-400">Assigned</div>
              <div className="mt-1 font-semibold text-gray-900 dark:text-white">{taskType === "bbox_validation" ? bboxValidationAssigned : Number(overviewAny?.intervals?.validation_assigned || 0)}</div>
            </div>
          </div>
          {sourceSync?.errors?.length ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{sourceSync.errors.join("; ")}</div> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        {!isValidationTask ? <div className="card space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{taskCopy.importTitle}</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {taskCopy.importDescription}
            </p>
          </div>
          <input
            type="file"
            multiple
            accept="image/*,video/*"
            onChange={(event) => setUploadQueue(Array.from(event.target.files ?? []))}
            disabled={!canUploadMedia}
            className="block w-full text-sm text-gray-600 dark:text-gray-300"
          />
          {uploadQueue.length > 0 ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-800 dark:bg-gray-950">
              {uploadQueue.map((file) => (
                <div key={file.name} className="flex items-center justify-between py-1">
                  <span>{file.name}</span>
                  <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary" type="button" onClick={() => uploadMutation.mutate()} disabled={!canUploadMedia || uploadMutation.isPending || uploadQueue.length === 0}>
              {uploadMutation.isPending ? "Uploading..." : "Upload to preview"}
            </button>
            <button className="btn-secondary" type="button" onClick={() => finalizeMutation.mutate()} disabled={!canUploadMedia || !readyImportId || finalizeMutation.isPending}>
              {finalizeMutation.isPending ? "Finalizing..." : "Finalize import"}
            </button>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {hasVideoAssets
              ? "Для видео первый этап стартует сразу после успешной загрузки: выбранные исполнители получают задачи на интервалы. Finalize import нужен позже для image-only импортов или ручной догенерации bbox-задач по уже утвержденным интервалам."
              : taskType === "image_annotation"
                ? "Для image annotation нажмите Finalize import после preview, чтобы создать legacy Task-задания по загруженным изображениям."
                : canUploadMedia
                  ? "Для изображений нажмите Finalize import после preview, чтобы создать bbox-задачи для выбранных исполнителей."
                  : "Для этого типа проекта импорт медиа не используется."}
          </div>
          {uploadError ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{uploadError}</div> : null}
          {finalizeError ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{finalizeError}</div> : null}
          {lastUploadPreview ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
              <div>Processed assets: {lastUploadPreview.assets_processed}</div>
              <div>Failed assets: {lastUploadPreview.assets_failed}</div>
              <div>Frames detected: {lastUploadPreview.frames_total}</div>
              {lastUploadPreview.cleanup ? (
                <div className="mt-2">
                  Cleanup: duplicates removed {lastUploadPreview.cleanup.duplicates_removed ?? 0}, invalid frames removed {lastUploadPreview.cleanup.invalid_frames_removed ?? 0}
                </div>
              ) : null}
              {lastUploadPreview.ffmpeg ? (
                <div className={`mt-2 ${lastUploadPreview.ffmpeg.available ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>
                  ffmpeg: {String(lastUploadPreview.ffmpeg.message || "")}
                </div>
              ) : null}
              {lastUploadPreview.errors.length > 0 ? <div className="mt-2">Errors: {lastUploadPreview.errors.join("; ")}</div> : null}
            </div>
          ) : null}
        </div> : null}

        <div className="card space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Workflow configuration</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Live settings for import, routing, AI suggestions, and review quality control.</p>
          </div>
          <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <div>Labels: {projectQuery.data.label_schema.map((item) => item.name).join(", ") || "—"}</div>
            <div>Source sync: {sourceSync?.status || "not_required"}</div>
            {sourceSync?.required ? (
              <div>
                Source items: created {sourceSync.created}, skipped {sourceSync.skipped}
                {sourceSync.errors.length ? `, errors ${sourceSync.errors.join("; ")}` : ""}
              </div>
            ) : null}
            <div>Frame interval: {projectQuery.data.frame_interval_sec}s</div>
            <div>Annotators per frame: {projectQuery.data.assignments_per_task}</div>
            <div>Agreement threshold: {projectQuery.data.agreement_threshold}</div>
            <div>IoU threshold: {projectQuery.data.iou_threshold}</div>
            <div>Assignment scope: {String(projectQuery.data.participant_rules?.assignment_scope || "selected_only")}</div>
            <div>AI pre-labeling: {projectQuery.data.participant_rules?.ai_prelabel_enabled === false ? "disabled" : "enabled"}</div>
            <div>AI model: {String(projectQuery.data.participant_rules?.ai_model || "baseline-box-v1")}</div>
            <div>AI confidence: {String(projectQuery.data.participant_rules?.ai_confidence_threshold ?? 0.7)}</div>
            <div>Keyframe interval: {String(projectQuery.data.participant_rules?.video_keyframe_interval ?? 1)}</div>
            <div>Tracking: {String(projectQuery.data.participant_rules?.tracking_algorithm || "CSRT")}</div>
            <div>Task batch size: {String(projectQuery.data.participant_rules?.task_batch_size ?? 10)}</div>
            <div>Min consecutive frames: {String(projectQuery.data.participant_rules?.min_sequence_size ?? 3)}</div>
            <div>Annotator pool size: {projectQuery.data.allowed_annotator_ids.length}</div>
            <div>Workflow batches created: {String(overview?.work_items?.workflow_batches_total ?? 0)}</div>
            <div>Validation-ready frames: {String(overview?.work_items?.validation_ready_items ?? 0)}</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="font-medium text-gray-900 dark:text-white">Instructions</div>
            <div className="mt-2 whitespace-pre-wrap text-gray-600 dark:text-gray-400">{projectQuery.data.instructions || "No instructions added yet."}</div>
            {projectQuery.data.instructions_file_uri ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-800 dark:bg-gray-950">
                <div className="text-gray-600 dark:text-gray-400">
                  Файл: <a className="text-blue-600 hover:underline dark:text-blue-400" href={projectQuery.data.instructions_file_uri} target="_blank" rel="noreferrer">{projectQuery.data.instructions_file_name || "instruction"}</a>
                </div>
                <div className="text-gray-500 dark:text-gray-400">
                  v{projectQuery.data.instructions_version ?? 0}{projectQuery.data.instructions_updated_at ? ` · ${new Date(projectQuery.data.instructions_updated_at).toLocaleString()}` : ""}
                </div>
              </div>
            ) : null}
            {(user?.role === "customer" || user?.role === "admin") ? (
              <div className="mt-3 space-y-2">
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Загрузить файл инструкции (PDF/DOCX/MD/TXT)</div>
                <input
                  type="file"
                  accept=".pdf,.docx,.md,.txt"
                  onChange={(event) => setInstructionFile((event.target.files?.[0] as File | undefined) ?? null)}
                  className="block w-full text-sm text-gray-600 dark:text-gray-300"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!instructionFile || instructionUploadMutation.isPending}
                    onClick={() => instructionUploadMutation.mutate()}
                  >
                    {instructionUploadMutation.isPending ? "Загрузка..." : "Загрузить новую версию"}
                  </button>
                </div>
                {instructionUploadError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{instructionUploadError}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <DawidSkeneQuality projectId={projectId!} />

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Annotator quality snapshot</h2>
          {overviewQuery.isFetching ? <span className="text-sm text-gray-500">Refreshing…</span> : null}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="table min-w-full text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 text-left">Annotator</th>
                <th className="py-2 pr-3 text-left">Rating</th>
                <th className="py-2 pr-3 text-left">Open</th>
                <th className="py-2 pr-3 text-left">Submitted</th>
                <th className="py-2 pr-3 text-left">Conflict rate</th>
              </tr>
            </thead>
            <tbody>
              {(overview?.annotators ?? []).map((annotator) => (
                <tr key={annotator.user_id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3">{annotator.username}</td>
                  <td className="py-2 pr-3">{annotator.rating?.toFixed(2) ?? "0.00"}</td>
                  <td className="py-2 pr-3">{annotator.open_assignments}</td>
                  <td className="py-2 pr-3">{annotator.submitted_assignments}</td>
                  <td className="py-2 pr-3">{annotator.conflict_rate?.toFixed(2) ?? "0.00"}</td>
                </tr>
              ))}
              {(overview?.annotators ?? []).length === 0 ? (
                <tr>
                  <td className="py-4 text-gray-500" colSpan={5}>No annotators assigned yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Security / audit events</h2>
          {securityEventsQuery.isFetching ? <span className="text-sm text-gray-500">Refreshing…</span> : null}
        </div>
        <div className="mt-4 space-y-2">
          {(securityEventsQuery.data?.items ?? []).slice(0, 10).map((event) => (
            <div key={event.id} className="rounded-lg border border-gray-200 p-3 text-xs dark:border-gray-800">
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-900 dark:text-white">{event.event_type}</span>
                <span className="text-gray-500">{new Date(event.created_at).toLocaleString()}</span>
              </div>
              <div className="mt-1 text-gray-500 dark:text-gray-400">severity: {event.severity}</div>
              <pre className="mt-2 max-h-24 overflow-auto rounded bg-gray-950 p-2 text-[11px] text-green-200">{JSON.stringify(event.payload, null, 2)}</pre>
            </div>
          ))}
          {(securityEventsQuery.data?.items ?? []).length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">No events yet.</div>
          ) : null}
        </div>
      </div>

      {exportPayload ? (
        <div className="card">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Export preview</h2>
          <pre className="mt-4 max-h-[420px] overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-green-200">{exportPayload}</pre>
        </div>
      ) : null}

    </div>
  );
}
