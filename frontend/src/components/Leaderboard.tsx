/**
 * Лидерборд проекта
 * - Топ-10 аннотаторов
 * - Медные, серебряные, золотые медали
 * - Подсветка текущего пользователя
 */

import { useQuery } from "@tanstack/react-query";
import { leaderboardAPI } from "../services/api";
import { useAuthStore } from "../store";
import { LoadingSpinner } from "./LoadingSpinner";
import { LeaderboardEntry } from "../types";

const MEDAL_ICONS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };
const POSITION_GRADIENTS: Record<number, string> = { 1: "from-yellow-400 to-amber-500", 2: "from-gray-300 to-slate-400", 3: "from-amber-500 to-orange-600" };

function LeaderboardRow({ entry, isCurrentUser }: { entry: LeaderboardEntry; isCurrentUser: boolean }) {
  const isTop3 = entry.position <= 3;

  return (
    <div className={`flex items-center gap-4 px-6 py-4 transition-colors duration-200 ${
      isCurrentUser ? "bg-blue-50 dark:bg-blue-900/20 border-l-4 border-blue-500" : "border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50"
    }`}>
      <div className="flex-shrink-0 w-10 text-center">
        {isTop3 ? <span className="text-2xl">{MEDAL_ICONS[entry.position]}</span> : <span className={`text-lg font-bold ${isCurrentUser ? "text-blue-600" : "text-gray-400"}`}>#{entry.position}</span>}
      </div>
      <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white shadow-md ${
        isTop3 ? `bg-gradient-to-br ${POSITION_GRADIENTS[entry.position]}` : isCurrentUser ? "bg-gradient-to-br from-blue-400 to-indigo-500" : "bg-gray-300 dark:bg-gray-600"
      }`}>
        {entry.username.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-semibold truncate ${isCurrentUser ? "text-blue-700 dark:text-blue-300" : "text-gray-900 dark:text-white"}`}>
          {entry.username}
          {isCurrentUser && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-800 text-blue-700">Вы</span>}
        </p>
        <p className="text-xs text-gray-500 truncate">{entry.email}</p>
      </div>
      <div className="hidden md:flex items-center gap-6 text-sm">
        <div className="text-center">
          <p className="font-bold text-gray-900 dark:text-white">{entry.completed_tasks}</p>
          <p className="text-xs text-gray-500">Задач</p>
        </div>
        <div className="text-center">
          <p className={`font-bold ${entry.average_f1 >= 0.9 ? "text-green-600" : entry.average_f1 >= 0.7 ? "text-yellow-600" : "text-red-600"}`}>
            {(entry.average_f1 * 100).toFixed(0)}%
          </p>
          <p className="text-xs text-gray-500">Точность</p>
        </div>
        <div className="text-center">
          <p className="font-bold text-gray-900">⭐ {entry.rating.toFixed(1)}</p>
          <p className="text-xs text-gray-500">Рейтинг</p>
        </div>
      </div>
    </div>
  );
}

export function Leaderboard({ projectId }: { projectId: string }) {
  const { user } = useAuthStore();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["leaderboard", projectId],
    queryFn: () => leaderboardAPI.getProjectLeaderboard(projectId),
    enabled: !!projectId,
  });

  if (isLoading) return <LoadingSpinner />;
  if (isError) return <p className="text-red-500">❌ Ошибка загрузки лидерборда</p>;
  if (!data || data.leaderboard.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="text-4xl mb-4">🏆</p>
        <p className="text-lg font-medium">Пока нет данных</p>
        <p className="text-sm">Лидерборд появится после выполнения заданий</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">🏆 Лидерборд проекта</h2>
        <span className="text-sm text-gray-500">👥 Участников: {data.total_participants}</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
        {data.leaderboard.map((entry) => <LeaderboardRow key={entry.user_id} entry={entry} isCurrentUser={entry.user_id === user?.id} />)}
      </div>
      {data.current_user && data.current_user.position > 10 && (
        <div className="rounded-xl border-2 border-blue-400 overflow-hidden">
          <div className="px-4 py-2 bg-blue-50 text-xs text-blue-600 font-medium">📌 Ваша позиция</div>
          <LeaderboardRow entry={data.current_user} isCurrentUser={true} />
        </div>
      )}
    </div>
  );
}
