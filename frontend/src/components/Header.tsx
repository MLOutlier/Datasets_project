/**
 * Верхняя панель (Header)
 * - Фиксированная позиция сверху
 * - Переключатель темы
 * - Профиль пользователя и выход
 */

import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 glass border-b border-gray-200 dark:border-gray-700 transition-colors duration-300 h-16">
      <div className="h-full flex items-center justify-between px-6">
        {/* Логотип */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <span className="text-lg font-bold bg-gradient-primary bg-clip-text text-transparent hidden sm:inline">
            Dataset AI
          </span>
        </div>

        {/* Правая часть */}
        <div className="flex items-center gap-3">
          <ThemeToggle />

          {user ? (
            <div className="flex items-center gap-3">
              <div className="hidden sm:block text-right">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{user.username}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 capitalize">
                  {user.role === "customer" ? "Заказчик" : user.role === "annotator" ? "Аннотатор" : user.role === "reviewer" ? "Рецензент" : "Администратор"}
                </div>
              </div>
              <div className="w-9 h-9 rounded-full bg-gradient-primary flex items-center justify-center text-white font-semibold shadow-md">
                {user.username.charAt(0).toUpperCase()}
              </div>
              <button
                onClick={handleLogout}
                className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors duration-200"
                title="Выйти"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          ) : (
            <button onClick={() => navigate("/login")} className="btn-sm">Вход</button>
          )}
        </div>
      </div>
    </header>
  );
}