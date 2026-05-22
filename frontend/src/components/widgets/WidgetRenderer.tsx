import type { ProjectLabel, ProjectTaskType, ProjectWidgetType, Task } from "../../types";

export type WidgetPayload = Record<string, unknown>;

type WidgetProject = {
  task_type?: ProjectTaskType | string;
  widget_type?: ProjectWidgetType | string;
  label_schema?: ProjectLabel[];
};

type WidgetRendererProps = {
  project: WidgetProject;
  task?: Task | null;
  value: WidgetPayload;
  onChange: (next: WidgetPayload) => void;
};

type WidgetAdapter = {
  widget: string;
  runtime: "native-react" | "konva" | "video-js" | "external-ready";
  supports: string[];
};

export const WIDGET_ADAPTERS: Record<string, WidgetAdapter> = {
  text: { widget: "text", runtime: "native-react", supports: ["text_annotation"] },
  classification: { widget: "classification", runtime: "native-react", supports: ["classification"] },
  image_labels: { widget: "image_labels", runtime: "native-react", supports: ["image_annotation"] },
  comparison: { widget: "comparison", runtime: "native-react", supports: ["comparison"] },
  bbox: { widget: "bbox", runtime: "konva", supports: ["bbox_annotation"] },
  video_intervals: { widget: "video_intervals", runtime: "video-js", supports: ["video_annotation"] },
  interval_validation: { widget: "interval_validation", runtime: "video-js", supports: ["video_interval_validation"] },
  bbox_validation: { widget: "bbox_validation", runtime: "konva", supports: ["bbox_validation"] },
  image_polygon: { widget: "image_polygon", runtime: "external-ready", supports: ["future_polygon_annotation"] },
  highres_image: { widget: "highres_image", runtime: "external-ready", supports: ["future_openseadragon_annotation"] },
  label_studio_embed: { widget: "label_studio_embed", runtime: "external-ready", supports: ["future_multi_modal_annotation"] },
};

function metadata(task?: Task | null) {
  return (task?.metadata ?? {}) as Record<string, unknown>;
}

function update(value: WidgetPayload, patch: WidgetPayload, onChange: (next: WidgetPayload) => void) {
  onChange({ ...value, ...patch });
}

export function TextWidget({ task, value, onChange }: WidgetRendererProps) {
  return (
    <div className="space-y-3">
      <textarea
        className="input-field min-h-[180px]"
        value={String(value.text || "")}
        onChange={(event) => update(value, { text: event.target.value }, onChange)}
        placeholder="Введите текстовый ответ"
      />
    </div>
  );
}

export function ClassificationWidget({ project, value, onChange }: WidgetRendererProps) {
  return (
    <div className="space-y-3">
      <select className="input-field" value={String(value.label || "")} onChange={(event) => update(value, { label: event.target.value }, onChange)}>
        <option value="">Выберите класс</option>
        {(project.label_schema ?? []).map((label) => (
          <option key={label.name} value={label.name}>
            {label.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ImageLabelsWidget({ project, task, value, onChange }: WidgetRendererProps) {
  return (
    <div className="space-y-4">
      {task?.input_ref ? (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-950 dark:border-gray-800">
          <img src={task.input_ref} alt={task.title || "Task image"} className="mx-auto max-h-[52vh] w-auto max-w-full object-contain" />
        </div>
      ) : null}
      <select className="input-field" value={String(value.label || "")} onChange={(event) => update(value, { label: event.target.value }, onChange)}>
        <option value="">Выберите метку</option>
        {(project.label_schema ?? []).map((label) => (
          <option key={label.name} value={label.name}>
            {label.name}
          </option>
        ))}
      </select>
      <textarea
        className="input-field min-h-[96px]"
        value={String(value.answer || "")}
        onChange={(event) => update(value, { answer: event.target.value }, onChange)}
        placeholder="Комментарий к изображению"
      />
    </div>
  );
}

export function ComparisonWidget({ task, value, onChange }: WidgetRendererProps) {
  const meta = metadata(task);
  const optionA = String(meta.option_a || "A");
  const optionB = String(meta.option_b || "B");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {[
          ["A", optionA],
          ["B", optionB],
        ].map(([choice, label]) => (
          <button
            key={choice}
            type="button"
            onClick={() => update(value, { choice }, onChange)}
            className={`rounded-lg border p-4 text-left transition ${
              value.choice === choice
                ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950"
                : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"
            }`}
          >
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Вариант {choice}</div>
            <div className="mt-2 font-medium text-gray-900 dark:text-white">{label}</div>
          </button>
        ))}
      </div>
      <textarea
        className="input-field min-h-[96px]"
        value={String(value.answer || "")}
        onChange={(event) => update(value, { answer: event.target.value }, onChange)}
        placeholder="Комментарий к выбору"
      />
    </div>
  );
}

export function isWidgetPayloadComplete(widgetType: string | undefined, taskType: string | undefined, payload: WidgetPayload) {
  const widget = String(widgetType || taskType || "");
  if (widget === "comparison" || taskType === "comparison") return String(payload.choice || "").trim() !== "";
  if (widget === "classification" || widget === "image_labels" || taskType === "classification" || taskType === "image_annotation") {
    return String(payload.label || "").trim() !== "";
  }
  if (widget === "text" || taskType === "text_annotation") return String(payload.text || "").trim() !== "";
  return Object.keys(payload).length > 0;
}

export function WidgetRenderer(props: WidgetRendererProps) {
  const widgetType = String(props.project.widget_type || props.project.task_type || "");
  if (widgetType === "classification") return <ClassificationWidget {...props} />;
  if (widgetType === "image_labels") return <ImageLabelsWidget {...props} />;
  if (widgetType === "comparison") return <ComparisonWidget {...props} />;
  return <TextWidget {...props} />;
}
