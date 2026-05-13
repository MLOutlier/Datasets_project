import { FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { annotatorAPI, projectsAPI, tasksAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";

function taskTitle(taskType?: string) {
  switch (taskType) {
    case "text_annotation":
      return "Текстовая разметка";
    case "image_annotation":
      return "Разметка изображения";
    case "classification":
      return "Классификация";
    case "comparison":
      return "Сравнение";
    default:
      return "Generic-задание";
  }
}

export default function GenericLabelingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");
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
  const taskMetadata = (currentTask?.metadata ?? {}) as Record<string, unknown>;
  const optionA = String(taskMetadata.option_a || "A");
  const optionB = String(taskMetadata.option_b || "B");
  const prompt = String(taskMetadata.prompt || currentTask?.title || "");
  const requiresLabel = taskType === "classification" || taskType === "image_annotation";
  const requiresComparisonChoice = taskType === "comparison";

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!currentTask) throw new Error("Нет доступного задания");
      const labelData =
        taskType === "classification" || taskType === "image_annotation"
          ? { label: selectedLabel, answer }
          : taskType === "comparison"
            ? { choice: selectedLabel, answer }
            : { text: answer };
      return tasksAPI.annotate(currentTask.id, {
        annotation_format: "generic_v1",
        label_data: labelData,
        is_final: true,
      });
    },
    onSuccess: async () => {
      setAnswer("");
      setSelectedLabel("");
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
        <Link to="/labeling" className="btn-secondary">
          К проектам
        </Link>
      </div>

      <div className="card space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Инструкция</h2>
          <div className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{project.instructions || "Инструкция пока не добавлена."}</div>
        </div>
      </div>

      {!currentTask ? (
        <div className="card p-10 text-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Нет доступных заданий</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Проект создан как отдельный generic-тип. Для работы нужны legacy Task-задания, привязанные к этому проекту.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            submitMutation.mutate();
          }}
          className="card space-y-4"
        >
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Задание</div>
            <h2 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{currentTask.title || "Task"}</h2>
            {prompt && prompt !== currentTask.title ? <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{prompt}</p> : null}
            {currentTask.input_ref ? (
              <a className="mt-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400" href={currentTask.input_ref} target="_blank" rel="noreferrer">
                Открыть материал
              </a>
            ) : null}
          </div>

          {requiresComparisonChoice ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">Выбор</label>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {[
                  ["A", optionA],
                  ["B", optionB],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSelectedLabel(value)}
                    className={`rounded-lg border p-4 text-left transition ${selectedLabel === value ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"}`}
                  >
                    <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Вариант {value}</div>
                    <div className="mt-2 font-medium text-gray-900 dark:text-white">{label}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : project.label_schema.length ? (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Метка{requiresLabel ? "" : " / выбор"}</label>
              <select className="input-field" value={selectedLabel} onChange={(event) => setSelectedLabel(event.target.value)}>
                <option value="">Без выбора</option>
                {project.label_schema.map((label) => (
                  <option key={label.name} value={label.name}>
                    {label.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Ответ</label>
            <textarea className="input-field min-h-[160px]" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Введите ответ или комментарий..." />
          </div>

          {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

          <div className="flex justify-end">
            <button type="submit" className="btn-primary" disabled={submitMutation.isPending || (requiresLabel && !selectedLabel) || (requiresComparisonChoice && !selectedLabel) || (!answer && !selectedLabel)}>
              {submitMutation.isPending ? "Отправляем..." : "Отправить"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
