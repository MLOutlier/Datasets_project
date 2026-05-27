import React, { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { datasetsAPI, tasksAPI, usersAPI } from "../services/api";
import { ApiListResponse, Dataset, Task } from "../types";
import { useAuthStore } from "../store";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { isAnnotatorRole, isCustomerRole } from "../utils/roles";

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const role = user?.role ?? "customer";
  const isCustomer = isCustomerRole(role);
  const isAnnotator = isAnnotatorRole(role);

  const [showBulkModal, setShowBulkModal] = useState(false);
  const [groupsInput, setGroupsInput] = useState("");
  const [specializationInput, setSpecializationInput] = useState("");
  const [experienceLevelInput, setExperienceLevelInput] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const datasetsQuery = useQuery<ApiListResponse<Dataset>>({
    queryKey: ["dashboard-datasets"],
    queryFn: () => datasetsAPI.list({ limit: 1, offset: 0 }),
  });

  const tasksQuery = useQuery<ApiListResponse<Task>>({
    queryKey: ["dashboard-tasks"],
    queryFn: () => tasksAPI.list({ limit: 5, offset: 0 }),
  });

  const datasetsTotal = datasetsQuery.data?.total ?? datasetsQuery.data?.items?.length ?? 0;
  const completedTasksCount = tasksQuery.data?.items?.filter((t) => t.status === "completed").length ?? 0;
  const inProgressTasksCount = tasksQuery.data?.items?.filter((t) => t.status === "in_progress").length ?? 0;
  const pendingTasksCount = tasksQuery.data?.items?.filter((t) => t.status === "pending").length ?? 0;
  const recentTasks = tasksQuery.data?.items ?? [];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setUploadFile(e.target.files[0]);
    }
  };

  const handleBulkUpload = async () => {
    if (!uploadFile) return;
    setIsUploading(true);
    try {
      const blob = await usersAPI.bulkCreateAnnotators(uploadFile, groupsInput, specializationInput, experienceLevelInput);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "annotators_credentials.txt";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      setShowBulkModal(false);
      setUploadFile(null);
      setGroupsInput("");
      setSpecializationInput("");
      setExperienceLevelInput("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      console.error("Ошибка загрузки", error);
      alert("Ошибка при создании аннотаторов. Проверьте формат файла.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Заголовок */}
      <div className="pb-6 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">📊 Дашборд</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Добро пожаловать,{" "}
          <span className="font-semibold text-primary-600 dark:text-primary-400">{user?.username ?? "Пользователь"}</span>
          ! {isAnnotator ? "Здесь только ваши рабочие инструменты." : "Здесь инструменты управления проектами."}
        </p>
      </div>

      {/* Кнопка массовой загрузки аннотаторов */}
      {isCustomer && (
        <div className="flex justify-end">
          <button onClick={() => setShowBulkModal(true)} className="btn-primary flex items-center gap-2">
            <span>👥</span> Загрузить список аннотаторов
          </button>
        </div>
      )}

      {/* Статистика */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {(isCustomer
          ? [
              { label: "Датасеты", value: datasetsTotal, icon: "📁", color: "from-blue-500 to-blue-600", link: "/datasets", description: "Всего датасетов" },
              { label: "Задачи в работе", value: inProgressTasksCount, icon: "⏳", color: "from-yellow-500 to-yellow-600", link: "/tasks", description: "Активные задачи" },
              { label: "Завершено", value: completedTasksCount, icon: "✅", color: "from-green-500 to-green-600", link: "/tasks", description: "Готовые задачи" },
              { label: "Баланс", value: "0 ₽", icon: "💰", color: "from-purple-500 to-purple-600", link: "/finance", description: "Доступно средств" },
            ]
          : [
              { label: "Мои задачи", value: recentTasks.length, icon: "🧩", color: "from-blue-500 to-blue-600", link: "/tasks", description: "Всего доступных задач" },
              { label: "В работе", value: inProgressTasksCount, icon: "⏳", color: "from-yellow-500 to-yellow-600", link: "/labeling", description: "Текущая разметка" },
              { label: "Завершено", value: completedTasksCount, icon: "✅", color: "from-green-500 to-green-600", link: "/tasks", description: "Сданные задания" },
              { label: "Ожидают", value: pendingTasksCount, icon: "📝", color: "from-purple-500 to-purple-600", link: "/tasks", description: "Готовы к старту" },
            ]
        ).map((stat) => (
          <Link key={stat.label} to={stat.link} className="group block">
            <div className="card card-hover h-full">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{stat.label}</p>
                  <p className="text-4xl font-bold text-gray-900 dark:text-white mt-2 group-hover:scale-105 transition-transform">{stat.value}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">{stat.description}</p>
                </div>
                <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${stat.color} flex items-center justify-center text-2xl shadow-lg group-hover:shadow-xl transition-shadow`}>
                  {stat.icon}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Быстрые действия */}
      <div className="card">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">⚡ Быстрые действия</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(isCustomer
            ? [
                { to: "/datasets", title: "Создать датасет", description: "Новый проект", icon: "📁", bg: "blue" },
                { to: "/tasks", title: "Задачи", description: "Посмотреть все", icon: "✅", bg: "green" },
                { to: "/finance", title: "Оплатить исполнителя", description: "Переводы и пополнение", icon: "💸", bg: "purple" },
              ]
            : [
                { to: "/labeling", title: "Открыть разметку", description: "Перейти к выполнению", icon: "🏷️", bg: "blue" },
                { to: "/tasks", title: "Мои задачи", description: "Статусы и прогресс", icon: "✅", bg: "green" },
                { to: "/finance", title: "Вывести средства", description: "История и выплаты", icon: "💰", bg: "purple" },
              ]
          ).map((action) => (
            <Link key={action.title} to={action.to} className={`p-5 rounded-xl bg-gradient-to-br from-${action.bg}-50 to-${action.bg}-100 dark:from-${action.bg}-900/20 dark:to-${action.bg}-900/10 border border-${action.bg}-200 dark:border-${action.bg}-800 hover:shadow-lg transition-all group`}>
              <div className="flex items-center gap-3">
                <div className={`w-12 h-12 rounded-lg bg-${action.bg}-600 dark:bg-${action.bg}-500 flex items-center justify-center text-white text-xl group-hover:scale-110 transition-transform`}>
                  {action.icon}
                </div>
                <div>
                  <p className="font-semibold text-gray-900 dark:text-white">{action.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{action.description}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Недавняя активность */}
      <div className="card">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">📋 Недавняя активность</h2>
          <Link to="/tasks" className="text-sm text-primary-600 dark:text-primary-400 hover:underline font-medium">Все задачи →</Link>
        </div>

        {tasksQuery.isLoading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <LoadingSpinner size="lg" />
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Загрузка задач...</p>
          </div>
        ) : tasksQuery.isError ? (
          <div className="flex flex-col items-center justify-center py-12">
            <svg className="w-16 h-16 text-red-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-red-600 dark:text-red-400">Не удалось загрузить задачи</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Проверьте подключение к серверу</p>
          </div>
        ) : recentTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <svg className="w-16 h-16 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Задач пока нет</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              {isCustomer ? 'Создайте первую задачу в разделе "Задачи"' : 'Новые задания появятся после назначения'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="py-3 px-4">ID</th>
                  <th className="py-3 px-4">Датасет</th>
                  <th className="py-3 px-4">Статус</th>
                  <th className="py-3 px-4">Действия</th>
                </tr>
              </thead>
              <tbody>
                {recentTasks.map((t) => (
                  <tr key={t.id}>
                    <td className="py-3 px-4 font-mono text-xs text-gray-600 dark:text-gray-400">{t.id.slice(0, 8)}...</td>
                    <td className="py-3 px-4 text-gray-900 dark:text-white">
                      <Link to={`/datasets/${t.dataset_id}`} className="text-primary-600 dark:text-primary-400 hover:underline">{t.dataset_id.slice(0, 12)}...</Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`badge ${t.status === "completed" ? "badge-success" : t.status === "in_progress" ? "badge-warning" : "badge-secondary"}`}>
                        {t.status === "completed" && "✅ "}{t.status === "in_progress" && "⏳ "}{t.status === "pending" && "📝 "}{t.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <Link to={`/tasks/${t.id}`} className="btn-sm">Открыть</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Начало работы */}
      <div className="card bg-gradient-to-br from-primary-50 to-secondary-50 dark:from-primary-900/20 dark:to-secondary-900/20 border-primary-200 dark:border-primary-800">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">💡 Начало работы</h2>
        <div className="space-y-4">
          {(isCustomer
            ? [
                { title: "Создайте первый датасет", description: "Добавьте датасет с описанием ваших данных", linkTo: "/datasets", linkLabel: "Добавьте датасет" },
                { title: "Добавьте задачи для разметки", description: "Создайте задачи и настройте параметры аннотации", linkTo: "/tasks", linkLabel: "Создайте задачи" },
                { title: "Назначьте исполнителей", description: "Следите за прогрессом и качеством выполнения", linkTo: "/quality", linkLabel: "Откройте качество" },
              ]
            : [
                { title: "Выберите задачу", description: "Откройте список доступных задач и выберите нужную", linkTo: "/tasks", linkLabel: "Перейдите к задачам" },
                { title: "Выполните разметку", description: "Сохраните черновик или отправьте результат на проверку", linkTo: "/labeling", linkLabel: "Откройте разметку" },
                { title: "Проверьте выплаты", description: "Следите за начислениями и выводом средств", linkTo: "/finance", linkLabel: "Откройте финансы" },
              ]
          ).map((step, index) => (
            <div key={step.title} className="flex items-start gap-4">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-600 dark:bg-primary-500 text-white flex items-center justify-center text-sm font-bold">{index + 1}</div>
              <div className="flex-1">
                <p className="font-medium text-gray-900 dark:text-white">{step.title}</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  <Link to={step.linkTo} className="text-primary-600 dark:text-primary-400 hover:underline">{step.linkLabel}</Link> {step.description.toLowerCase()}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Модальное окно массовой загрузки */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">👥 Массовое создание аннотаторов</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">Загрузите текстовый файл (.txt) со списком «Имя Фамилия» (по одному на строку). Для каждого будет создан аккаунт с автоматически сгенерированными учётными данными.</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Файл со списком аннотаторов *</label>
                <input type="file" accept=".txt,text/plain" ref={fileInputRef} onChange={handleFileChange} className="input-field" />
                <p className="text-xs text-gray-500 mt-1">Пример: Иван Петров</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Группы / Команды</label>
                <input type="text" value={groupsInput} onChange={(e) => setGroupsInput(e.target.value)} placeholder="Команда А, Проект Б, Отдел разметки" className="input-field" />
                <p className="text-xs text-gray-500 mt-1">Через запятую. Аннотаторы будут добавлены во все указанные группы.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Специализация (опционально)</label>
                <input type="text" value={specializationInput} onChange={(e) => setSpecializationInput(e.target.value)} placeholder="CV, NLP, Audio" className="input-field" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Уровень опыта (опционально)</label>
                <select value={experienceLevelInput} onChange={(e) => setExperienceLevelInput(e.target.value)} className="input-field">
                  <option value="">Не указан</option>
                  <option value="junior">Junior</option>
                  <option value="middle">Middle</option>
                  <option value="senior">Senior</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowBulkModal(false)} className="btn-secondary" disabled={isUploading}>Отмена</button>
              <button onClick={handleBulkUpload} className="btn-primary flex items-center gap-2" disabled={!uploadFile || isUploading}>
                {isUploading ? <> <LoadingSpinner size="sm" /> Создание... </> : <> <span>📤</span> Создать аннотаторов </>}
              </button>
            </div>

            <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <p className="text-sm text-blue-800 dark:text-blue-300"><strong>💡 После создания:</strong> автоматически скачается файл с логинами и паролями. Если аннотатор с таким именем уже существует – он будет пропущен.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
