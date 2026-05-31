import { useNavigate } from "react-router-dom";
import { roleLabel } from "../lib/projectDisplay";
import { useAuthStore } from "../store";
import { NotificationBell } from "./NotificationBell";
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
    <header className="glass fixed left-0 right-0 top-0 z-50 h-16 border-b border-gray-200 transition-colors duration-300 dark:border-gray-700">
      <div className="flex h-full items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <span className="hidden bg-gradient-primary bg-clip-text text-lg font-bold text-transparent sm:inline">
            Dataset AI
          </span>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <NotificationBell />

          {user ? (
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{user.username}</div>
                <div className="text-xs capitalize text-gray-500 dark:text-gray-400">{roleLabel(user.role)}</div>
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-primary font-semibold text-white shadow-md">
                {user.username.charAt(0).toUpperCase()}
              </div>
              <button
                onClick={handleLogout}
                className="rounded-lg p-2 text-gray-600 transition-colors duration-200 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                title="Sign out"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          ) : (
            <button onClick={() => navigate("/login")} className="btn-sm">
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
