import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { datasetsAPI } from "../services/api";
import { Dataset, DatasetUpdateRequest } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store/useAuthStore";

export function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const datasetQuery = useQuery<Dataset>({
    queryKey: ["dataset", id],
    queryFn: () => (id ? datasetsAPI.detail(id) : Promise.reject(new Error("Нет ID датасета"))),
    enabled: !!id,
  });

  const updateMutation = useMutation({
    mutationFn: (body: DatasetUpdateRequest) => (id ? datasetsAPI.update(id, body as Record<string, unknown>) : Promise.reject(new Error("Нет ID"))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dataset", id] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => { if (id) await datasetsAPI.remove(id); },
    onSuccess: () => navigate("/datasets"),
  });

  const [form, setForm] = React.useState<Pick<Dataset, "name" | "status" | "description">>({ name: "", status: "draft", description: "" });
  const [exportFormat, setExportFormat] = React.useState<"voc" | "coco" | "yolo" | "tfrecord">("coco");
  const [isExporting, setIsExporting] = React.useState(false);

  const handleExport = async () => {
    if (!id) return;
    setIsExporting(true);
    try {
      const blob = await datasetsAPI.exportDataset(id, exportFormat);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dataset-${id}-export.${exportFormat === "tfrecord" ? "tfrecord" : "zip"}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Ошибка экспорта:", error);
      alert("Ошибка при скачивании датасета");
    } finally {
      setIsExporting(false);
    }
  };

  React.useEffect(() => {
    if (datasetQuery.data) setForm({ name: datasetQuery.data.name, status: datasetQuery.data.status, description: datasetQuery.data.description });
  }, [datasetQuery.data]);

  if (datasetQuery.isLoading) return <LoadingSpinner />;
  if (datasetQuery.isError) return <div className="text-red-500">❌ Не удалось загрузить датасет</div>;
  if (!datasetQuery.data) return null;

  return (
    <div className="space-y-4">
      <div className="card">
        <h1 className="text-xl font-semibold text-gray-900">📁 {datasetQuery.data.name}</h1>
        <p className="mt-1 text-sm text-gray-600">Управление датасетом</p>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">✏️ Редактирование</h2>
        <div className="space-y-4">
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Название</label><input className="input-field" value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Статус</label><select className="input-field" value={form.status} onChange={(e) => setForm((s) => ({ ...s, status: e.target.value as Dataset["status"] }))}><option value="draft">📝 Черновик</option><option value="active">✅ Активен</option><option value="archived">🗄️ Архив</option></select></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Описание</label><textarea className="input-field" rows={3} value={form.description} onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))} /></div>
          <div className="flex gap-3">
            <button className="btn-primary" onClick={() => updateMutation.mutate(form)} disabled={updateMutation.isPending}>{updateMutation.isPending ? "Сохранение..." : "💾 Сохранить"}</button>
            {user?.role === "customer" && <button className="btn-secondary border-red-200 text-red-700 hover:bg-red-50" onClick={() => { if (window.confirm("Удалить датасет? Это действие необратимо.")) deleteMutation.mutate(); }}>🗑️ Удалить</button>}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">📊 Метаданные</h2>
        <pre className="max-h-[400px] overflow-auto rounded-md bg-gray-50 p-3 text-xs">{JSON.stringify(datasetQuery.data.metadata ?? {}, null, 2)}</pre>
      </div>

      {user?.role === "customer" && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">📤 Экспорт разметки</h2>
          <div className="flex items-center gap-4">
            <select className="input-field w-auto" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as any)}>
              <option value="voc">PASCAL VOC</option><option value="coco">COCO</option><option value="yolo">YOLO</option><option value="tfrecord">TFRecord</option>
            </select>
            <button className="btn-primary" onClick={handleExport} disabled={isExporting}>{isExporting ? "Скачивание..." : "📥 Скачать"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
