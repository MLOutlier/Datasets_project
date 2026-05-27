import { FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { annotatorAPI, projectsAPI, tasksAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { WidgetRenderer, isWidgetPayloadComplete, type WidgetPayload } from "../components/widgets/WidgetRenderer";
import { InstructionGate, InstructionPanel } from "../components/InstructionPanel";

function taskTitle(taskType?: string) {
  switch (taskType) {
    case "text_annotation":
      return "Текстовая разметка";
    case "image_annotation":
      return "Разметка изображений";
    case "classification":
      return "Классификация";
    case "comparison":
      return "Сравнение";
    default:
      return "Задание";
  }
}

export default function GenericLabelingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const [payload, setPayload] = useState<WidgetPayload>({});
  const [error, setError] = useState("");

  const projectQuery = useQuery({
    queryKey: ["annotator-project-detail", projectId],
    queryFn: () => annotatorAPI.projectDetail(projectId!),
    enabled: !!projectId,
  });
  const taskQuery = useQuery({
    queryKey: ["tasks", "generic-next", projectId],
    queryFn: () => projectsAPI.nextTask(projectId!),
    enabled: !!projectId,
    retry: false,
  });

  const currentTask = taskQuery.data;
  const project = projectQuery.data;
  const taskType = String(project?.task_type || "");
  const widgetType = String(project?.widget_type || taskType || "");
  const taskMetadata = (currentTask?.metadata ?? {}) as Record<string, unknown>;
  const prompt = String(taskMetadata.prompt || currentTask?.title || "");
  const payloadComplete = isWidgetPayloadComplete(widgetType, taskType, payload);
  const instructionsAcknowledged = project?.instructions_bundle?.acknowledgement?.acknowledged ?? true;

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!currentTask) throw new Error("Нет доступного задания");
      return tasksAPI.annotate(currentTask.id, {
        annotation_format: "generic_v1",
        label_data: payload,
        is_final: true,
      });
    },
    onSuccess: async () => {
      setPayload({});
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["tasks", "generic-next", projectId] });
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail || err?.message || "Не удалось отправить ответ");
    },
  });

  if (projectQuery.isLoading || taskQuery.isLoading) {
    return <LoadingSpinner size="lg" />;
  }

  if (!project) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Проект не найден</h1>
        <Link to="/labeling" className="btn-primary mt-4 inline-block">
          К проектам
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{project.widget_type}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{taskTitle(String(project.task_type))}</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{project.project_title}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <InstructionPanel projectId={project.project_id} bundle={project.instructions_bundle} fallbackText={project.instructions} compact />
          <Link to="/labeling" className="btn-secondary">
          К проектам
          </Link>
        </div>
      </div>

      <InstructionGate projectId={project.project_id} bundle={project.instructions_bundle} fallbackText={project.instructions} />

      {!currentTask ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Нет доступных заданий</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Проект готов, но заказчику ещё нужно добавить задания или импортировать данные.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (payloadComplete && instructionsAcknowledged) submitMutation.mutate();
          }}
          className="card space-y-4"
        >
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Задание</div>
            <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{currentTask.title || "Задание"}</h2>
            {prompt && prompt !== currentTask.title ? <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{prompt}</p> : null}
            {currentTask.input_ref ? (
              <a className="mt-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400" href={currentTask.input_ref} target="_blank" rel="noreferrer">
                Открыть исходный материал
              </a>
            ) : null}
          </div>

          <WidgetRenderer project={project} task={currentTask} value={payload} onChange={setPayload} />

          {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={submitMutation.isPending || !payloadComplete || !instructionsAcknowledged}>
              {submitMutation.isPending ? "Отправляем..." : "Отправить"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
