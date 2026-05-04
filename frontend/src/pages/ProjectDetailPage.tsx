import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsAPI, workflowAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [exportPayload, setExportPayload] = useState<string | null>(null);
  const [instructionFile, setInstructionFile] = useState<File | null>(null);
  const [instructionUploadError, setInstructionUploadError] = useState<string | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<"coco" | "yolo" | "voc" | "csv" | "both">("both");
  const [archiveError, setArchiveError] = useState<string | null>(null);

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
    mutationFn: async () => workflowAPI.export(projectId!, exportFormat),
    onSuccess: (payload) => {
      setExportPayload(JSON.stringify(payload, null, 2));
    },
  });

  const exportArchiveMutation = useMutation({
    mutationFn: async () => workflowAPI.exportArchive(projectId!, exportFormat),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `project-${projectId}-${exportFormat}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setArchiveError(null);
    },
    onError: (err: any) => {
      setArchiveError(err?.response?.data?.detail || err?.message || "Archive export failed");
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

  const overview = overviewQuery.data;
  const lastUploadPreview = uploadMutation.data?.preview;
  const readyImportId = activeImportId || String(overview?.imports?.latest_ready_import_id || "");
  const hasVideoAssets = Array.isArray(overview?.imports?.video_asset_ids) && overview.imports.video_asset_ids.length > 0;

  const completion = useMemo(() => {
    const total = Number(overview?.work_items?.total || 0);
    const done = Number(overview?.work_items?.completed || 0);
    return total > 0 ? Math.round((done / total) * 100) : 0;
  }, [overview]);

  if (projectQuery.isLoading) {
    return <LoadingSpinner size="lg" />;
  }

  if (!projectQuery.data) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">Project not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {projectQuery.data.project_type} / {projectQuery.data.annotation_type}
          </div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{projectQuery.data.title}</h1>
          <p className="mt-3 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{projectQuery.data.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to={`/projects/${projectId}/workflow`} className="btn-secondary">
            Настройка разметки
          </Link>
          <Link to={`/projects/${projectId}/intervals`} className="btn-secondary">
            Этап 1-2: Интервалы
          </Link>
          <Link to="/quality" className="btn-secondary">
            Этап 4: Валидация bbox
          </Link>
          <button className="btn-secondary" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
            {exportMutation.isPending ? "Exporting..." : "Export dataset"}
          </button>
          <button className="btn-secondary" onClick={() => exportArchiveMutation.mutate()} disabled={exportArchiveMutation.isPending}>
            {exportArchiveMutation.isPending ? "Preparing zip..." : "Download zip"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Frames</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{overview?.imports?.frames_total ?? 0}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Work items</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{overview?.work_items?.total ?? 0}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Low-agreement requeue</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{overview?.assignments?.disputed ?? 0}</div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-500 dark:text-gray-400">Completion</div>
          <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{completion}%</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <div className="card space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Import media</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Upload images or videos. Videos are split into frames using the project frame interval.</p>
          </div>
          <input
            type="file"
            multiple
            accept="image/*,video/*"
            onChange={(event) => setUploadQueue(Array.from(event.target.files ?? []))}
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
            <button className="btn-primary" type="button" onClick={() => uploadMutation.mutate()} disabled={uploadMutation.isPending || uploadQueue.length === 0}>
              {uploadMutation.isPending ? "Uploading..." : "Upload to preview"}
            </button>
            <button className="btn-secondary" type="button" onClick={() => finalizeMutation.mutate()} disabled={!readyImportId || finalizeMutation.isPending}>
              {finalizeMutation.isPending ? "Finalizing..." : "Finalize import"}
            </button>
            <select
              className="input-field w-auto"
              value={exportFormat}
              onChange={(event) => setExportFormat(event.target.value as "coco" | "yolo" | "voc" | "csv" | "both")}
            >
              <option value="both">Export: COCO + YOLO + VOC + CSV</option>
              <option value="coco">Export: COCO</option>
              <option value="yolo">Export: YOLO</option>
              <option value="voc">Export: VOC</option>
              <option value="csv">Export: CSV</option>
            </select>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {hasVideoAssets
              ? "Для видео первый этап стартует сразу после успешной загрузки: выбранные исполнители получают задачи на интервалы. Finalize import нужен позже для image-only импортов или ручной догенерации bbox-задач по уже утвержденным интервалам."
              : "Для изображений нажмите Finalize import после preview, чтобы создать bbox-задачи для выбранных исполнителей."}
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
          {archiveError ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{archiveError}</div> : null}
        </div>

        <div className="card space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Workflow configuration</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Live settings for import, routing, AI suggestions, and review quality control.</p>
          </div>
          <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <div>Labels: {projectQuery.data.label_schema.map((item) => item.name).join(", ") || "—"}</div>
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
