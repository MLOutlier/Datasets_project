import React, { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../store";
import { statsAPI, usersAPI } from "../services/api";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { UserStats } from "../types";

const LEVEL_ICONS: Record<string, string> = {
  novice: "🌱",
  intermediate: "🌿",
  advanced: "🔥",
  expert: "👑",
};

const LEVEL_GRADIENTS: Record<string, string> = {
  novice: "from-yellow-400 to-amber-500",
  intermediate: "from-emerald-400 to-green-500",
  advanced: "from-blue-400 to-indigo-500",
  expert: "from-violet-400 to-purple-500",
};

export function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const loadMe = useAuthStore((s) => s.loadMe);
  const setUser = useAuthStore((s) => s.setUser);

  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!user) loadMe();
  }, [user, loadMe]);

  const statsQuery = useQuery<UserStats>({
    queryKey: ["user-stats", user?.id],
    queryFn: () => statsAPI.myStats(),
    enabled: !!user?.id,
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      alert("Разрешены только изображения: JPG, PNG, GIF, WebP");
      return;
    }

    if (file.size > 500 * 1024) {
      alert("Файл слишком большой. Максимальный размер: 500KB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => setPreviewUrl(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const result = await usersAPI.uploadAvatar(file);
      if (user) setUser({ ...user, avatar_url: result.avatar_url });
      setPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      alert("Аватар успешно загружен!");
    } catch (error) {
      console.error("Ошибка загрузки аватарки:", error);
      alert("Ошибка при загрузке аватарки");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Удалить аватар?")) return;
    try {
      await usersAPI.deleteAvatar();
      if (user) setUser({ ...user, avatar_url: null });
      setPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      console.error("Ошибка удаления аватарки:", error);
      alert("Ошибка при удалении аватарки");
    }
  };

  const handleCancel = () => {
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (loading && !user) return <LoadingSpinner />;

  const stats = statsQuery.data;
  const rating = stats?.rating ?? user?.rating ?? 0;
  const level = stats?.level ?? "novice";
  const levelLabel = stats?.level_label ?? "Новичок";
  const levelColor = stats?.level_color ?? "#F59E0B";
  const levelGradient = LEVEL_GRADIENTS[level] ?? LEVEL_GRADIENTS.novice;
  const ratingPercent = Math.min(100, (rating / 5) * 100);
  const avatarUrl = previewUrl || user?.avatar_url || null;

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Карточка профиля */}
      <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700">
        <div className={`absolute inset-0 bg-gradient-to-br ${levelGradient} opacity-10 dark:opacity-20`} />

        <div className="relative p-8">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            {/* Аватар */}
            <div className="relative group">
              <div className={`w-24 h-24 rounded-full overflow-hidden bg-gradient-to-br ${levelGradient} flex items-center justify-center text-5xl shadow-lg transition-transform group-hover:scale-105`}>
                {avatarUrl ? (
                  <img src={avatarUrl} alt={user?.username} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-white text-3xl font-bold">{(user?.username || "U").charAt(0).toUpperCase()}</span>
                )}
              </div>

              <div className="absolute -bottom-2 -right-2 flex gap-1">
                {!previewUrl && (
                  <button onClick={() => fileInputRef.current?.click()} className="w-8 h-8 rounded-full bg-white dark:bg-gray-700 shadow-lg border border-gray-200 flex items-center justify-center text-sm hover:bg-gray-50 transition-colors" title="Загрузить фото">
                    📷
                  </button>
                )}
                {user?.avatar_url && !previewUrl && (
                  <button onClick={handleDelete} className="w-8 h-8 rounded-full bg-white dark:bg-gray-700 shadow-lg border border-gray-200 flex items-center justify-center text-sm hover:bg-red-50 transition-colors" title="Удалить фото">
                    🗑️
                  </button>
                )}
              </div>

              <div className="absolute -top-2 -right-2 px-3 py-1 rounded-full text-xs font-bold text-white shadow-md" style={{ backgroundColor: levelColor }}>
                {levelLabel}
              </div>
            </div>

            {/* Информация */}
            <div className="flex-1 space-y-3">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{user?.username}</h1>
                <p className="text-gray-600 dark:text-gray-400">{user?.email}</p>
              </div>

              {previewUrl && (
                <div className="flex gap-2">
                  <button onClick={handleUpload} disabled={isUploading} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
                    {isUploading ? "Загрузка..." : "💾 Сохранить фото"}
                  </button>
                  <button onClick={handleCancel} className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium hover:bg-gray-300 transition-colors">
                    Отмена
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-3 text-sm">
                <span className="px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium">
                  {user?.role === "customer" ? "🏢 Заказчик" : user?.role === "annotator" ? "✏️ Аннотатор" : "🛡️ Админ"}
                </span>
                {user?.specialization && (
                  <span className="px-3 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 font-medium">
                    🎯 {user.specialization}
                  </span>
                )}
                {user?.experience_level && (
                  <span className="px-3 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 font-medium">
                    📈 {user.experience_level}
                  </span>
                )}
              </div>

              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={handleFileSelect} className="hidden" />

              {user?.role === "annotator" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">⭐ Рейтинг: {rating.toFixed(2)}</span>
                    <span className="text-xs text-gray-500">До следующего уровня: {Math.max(0, (stats?.next_level_rating ?? 5) - rating).toFixed(2)}</span>
                  </div>
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden shadow-inner">
                    <div className={`h-full rounded-full bg-gradient-to-r ${levelGradient} transition-all duration-700 ease-out relative`} style={{ width: `${ratingPercent}%` }}>
                      <div className="absolute inset-0 bg-white opacity-20 rounded-full animate-pulse" />
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>0</span><span>2.0 (Новичок)</span><span>3.5 (Уверенный)</span><span>4.5 (Эксперт)</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Статистика */}
      {user?.role === "annotator" && (
        <>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">📊 Статистика</h2>
          {statsQuery.isLoading ? <LoadingSpinner /> : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard icon="✅" value={stats?.completed_tasks ?? 0} label="Выполнено задач" gradient="from-blue-400 to-indigo-500" bgClass="bg-blue-100 dark:bg-blue-900/30" />
              <StatCard icon="📝" value={stats?.total_annotations ?? 0} label="Всего аннотаций" gradient="from-emerald-400 to-green-500" bgClass="bg-emerald-100 dark:bg-emerald-900/30" />
              <StatCard icon="🎯" value={`${((stats?.average_f1 ?? 0) * 100).toFixed(1)}%`} label="Средняя точность (F1)" gradient="from-violet-400 to-purple-500" bgClass="bg-violet-100 dark:bg-violet-900/30" />
              <StatCard icon="🔍" value={stats?.reviews_count ?? 0} label="Quality checks" gradient="from-amber-400 to-orange-500" bgClass="bg-amber-100 dark:bg-amber-900/30" />
            </div>
          )}
        </>
      )}

      {/* Информация */}
      <div className="rounded-2xl bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-700 p-8">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">ℹ️ Информация</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <InfoRow label="Имя пользователя" value={user?.username ?? "—"} />
            <InfoRow label="Email" value={user?.email ?? "—"} />
            <InfoRow label="Роль" value={user?.role === "customer" ? "Заказчик" : user?.role === "annotator" ? "Аннотатор" : "Админ"} />
          </div>
          <div className="space-y-4">
            <InfoRow label="Специализация" value={user?.specialization || "Не указана"} />
            <InfoRow label="Уровень опыта" value={user?.experience_level || "Не указан"} />
            <InfoRow label="Баланс" value={user?.balance ? `${Number(user.balance).toFixed(2)} USD` : "0.00 USD"} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label, gradient, bgClass }: { icon: string; value: number | string; label: string; gradient: string; bgClass: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-700 p-6 group hover:shadow-xl transition-all duration-300">
      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-5 group-hover:opacity-10 transition-opacity`} />
      <div className="relative space-y-3">
        <div className={`w-12 h-12 rounded-xl ${bgClass} flex items-center justify-center text-2xl`}>{icon}</div>
        <div><p className="text-3xl font-bold text-gray-900 dark:text-white">{value}</p><p className="text-sm text-gray-600 dark:text-gray-400">{label}</p></div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span className="text-sm font-medium text-gray-900 dark:text-white">{value}</span>
    </div>
  );
}
