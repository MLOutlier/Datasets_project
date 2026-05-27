/**
 * Страница управления датасетами
 */

import React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { datasetsAPI } from "../services/api";
import { ApiListResponse, Dataset, DatasetCreateRequest } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";

const STATUS_LABELS: Record<string, { icon: string; label: string }> = {
  draft: { icon: "📝", label: "Черновик" },
  active: { icon: "✅", label: "Активен" },
  archived: { icon: "🗄️", label: "Архив" },
};

export function DatasetsPage() {
  const queryClient = useQueryClient();
  const [limit] = React.useState(20);
  const [offset, setOffset] = React.useState(0);
  const [form, setForm] = React.useState<DatasetCreateRequest>({ name: "", description: "", status: "draft", metadata: {} });

  const datasetsQuery = useQuery<ApiListResponse<Dataset>>({
    queryKey: ["datasets", limit, offset],
    queryFn: () => datasetsAPI.list({ limit, offset }),
  });

  const createMutation = useMutation({
    mutationFn: (body: DatasetCreateRequest) => datasetsAPI.create(body as unknown as Record<string, unknown>),
    onSuccess: () => {
      setForm({ name: "", description: "", status: "draft", metadata: {} });
      queryClient.invalidateQueries({ queryKey: ["datasets"] });
    },
  });

  const total = datasetsQuery.data?.total ?? 0;
  const items = datasetsQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="card">
        <h1 className="text-xl font-semibold text-gray-900">📁 Сбор датасетов</h1>
        <p className="mt-1 text-sm text-gray-600">Здесь создаются и управляются датасеты. Разметка выполняется в разделе «Разметка датасетов».</p>
      </div>

      {/* Форма создания */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">✨ Создание датасета</h2>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); createMutation.mutate(form); }}>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Название датасета *</label>
            <input type="text" value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} className="input-field" placeholder="Введите название датасета" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Описание</label>
            <textarea value={form.description ?? ""} onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))} className="input-field resize-none" rows={3} placeholder="Опишите датасет: тип данных, количество записей, источник..." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Статус</label>
            <select value={form.status ?? "draft"} onChange={(e) => setForm((s) => ({ ...s, status: e.target.value as DatasetCreateRequest["status"] }))} className="input-field">
              <option value="draft">📝 Черновик (draft)</option>
              <option value="active">✅ Активен (active)</option>
              <option value="archived">🗄️ Архив (archived)</option>
            </select>
          </div>
          <button type="submit" disabled={createMutation.isPending || !form.name.trim()} className="btn-primary w-full">
            {createMutation.isPending ? <span className="flex items-center justify-center gap-2"><LoadingSpinner size="sm" /> Создание...</span> : "✨ Создать датасет"}
          </button>
        </form>
        {createMutation.isError && (
          <div className="mt-4 p-4 rounded-lg bg-red-50 border border-red-200">
            <p className="text-sm font-medium text-red-800">❌ Ошибка создания датасета</p>
            <p className="text-xs text-red-600 mt-1">{(createMutation.error as any)?.response?.data?.detail || "Неизвестная ошибка"}</p>
          </div>
        )}
      </div>

      {/* Список датасетов */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">📋 Датасеты</h2>

        {datasetsQuery.isLoading ? (
          <div className="flex flex-col items-center justify-center py-12"><LoadingSpinner size="lg" /><p className="mt-4 text-sm text-gray-600">Загрузка датасетов...</p></div>
        ) : datasetsQuery.isError ? (
          <div className="flex flex-col items-center justify-center py-12 text-red-500">❌ Не удалось загрузить датасеты</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-500">
            <svg className="w-16 h-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
            <p className="text-sm font-medium">Датасетов пока нет</p>
            <p className="text-xs mt-2">Создайте первый датасет с помощью формы выше</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th className="py-3 px-4">Название</th><th className="py-3 px-4">Статус</th><th className="py-3 px-4">Версия</th><th className="py-3 px-4">Обновлено</th><th className="py-3 px-4">Действия</th></tr>
                </thead>
                <tbody>
                  {items.map((d) => (
                    <tr key={d.id}>
                      <td className="py-3 px-4"><Link to={`/datasets/${d.id}`} className="font-medium text-primary-600 hover:underline">{d.name}</Link></td>
                      <td className="py-3 px-4"><span className={`badge ${d.status === 'active' ? 'badge-success' : d.status === 'draft' ? 'badge-warning' : 'badge-secondary'}`}>{STATUS_LABELS[d.status]?.icon} {STATUS_LABELS[d.status]?.label}</span></td>
                      <td className="py-3 px-4 text-gray-600">v{d.schema_version ?? '1.0'}</td>
                      <td className="py-3 px-4 text-gray-600">{d.updated_at ? new Date(d.updated_at).toLocaleDateString('ru-RU') : '—'}</td>
                      <td className="py-3 px-4"><Link to={`/datasets/${d.id}`} className="btn-sm">Открыть</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-6 flex items-center justify-between border-t pt-4">
              <button onClick={() => setOffset((o) => Math.max(0, o - limit))} disabled={offset <= 0} className="btn-secondary disabled:opacity-50">← Назад</button>
              <span className="text-sm text-gray-600">Показано {offset + 1}–{Math.min(offset + limit, total)} из {total}</span>
              <button onClick={() => setOffset((o) => o + limit)} disabled={offset + limit >= total} className="btn-secondary disabled:opacity-50">Дальше →</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
