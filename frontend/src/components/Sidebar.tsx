import { NavLink } from "react-router-dom";
import { roleLabel } from "../lib/projectDisplay";
import { useAuthStore } from "../store";
import { Role } from "../types";

type NavItem = {
  to: string;
  label: string;
  icon: string;
  roles: Role[];
};

const items: NavItem[] = [
  { to: "/", label: "Dashboard", icon: "D", roles: ["customer", "annotator", "admin"] },
  { to: "/projects", label: "Projects", icon: "P", roles: ["customer", "admin"] },
  { to: "/datasets", label: "Datasets", icon: "DS", roles: ["customer", "annotator", "admin"] },
  { to: "/tasks", label: "Tasks", icon: "T", roles: ["customer", "annotator", "admin"] },
  { to: "/labeling", label: "Labeling", icon: "L", roles: ["annotator", "admin"] },
  { to: "/quality", label: "Quality", icon: "Q", roles: ["customer", "admin"] },
  { to: "/finance", label: "Finance", icon: "F", roles: ["customer", "annotator", "admin"] },
  { to: "/profile", label: "Profile", icon: "U", roles: ["customer", "annotator", "admin"] },
];

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const visibleItems = items.filter((item) => !role || item.roles.includes(role));

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-full w-72 min-w-[280px] flex-col border-r border-gray-200 bg-white transition-colors duration-300 dark:border-gray-700 dark:bg-gray-800">
      <div className="h-16 border-b border-gray-200 bg-gray-50 px-6 dark:border-gray-700 dark:bg-gray-900">
        <NavLink to="/" className="flex h-full items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <span className="bg-gradient-primary bg-clip-text text-lg font-bold text-transparent">Dataset AI</span>
        </NavLink>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-6">
        {visibleItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center rounded-lg px-4 py-3 text-sm font-medium transition-all duration-200 ${
                isActive
                  ? "bg-primary-100 text-primary-700 dark:bg-primary-900/20 dark:text-primary-300"
                  : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              }`
            }
          >
            <span className="mr-3 flex h-6 min-w-6 items-center justify-center rounded bg-gray-100 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-200">
              {item.icon}
            </span>
            <span className="flex-1">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900">
        {user ? (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-primary font-semibold text-white shadow-md">
              {user.username.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{user.username}</p>
              <p className="text-xs capitalize text-gray-500 dark:text-gray-400">{roleLabel(user.role)}</p>
            </div>
          </div>
        ) : (
          <p className="text-center text-xs text-gray-500 dark:text-gray-400">Not signed in</p>
        )}
      </div>
    </aside>
  );
}
