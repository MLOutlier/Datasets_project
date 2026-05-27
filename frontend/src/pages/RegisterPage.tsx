import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store";
import { RegisterRequest, Role } from "../types";

type RegisterFormValues = { email: string; username: string; password: string; role: Role };

export function RegisterPage() {
  const navigate = useNavigate();
  const registerUser = useAuthStore((s) => s.register);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const { register: rhfRegister, handleSubmit, formState: { errors } } = useForm<RegisterFormValues>({ mode: "onBlur", defaultValues: { role: "customer" } });

  const onSubmit = async (values: RegisterFormValues) => {
    try {
      await registerUser({ email: values.email, username: values.username, password: values.password, role: values.role });
      navigate("/profile");
    } catch (e) { console.error("Ошибка регистрации:", e); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-secondary-50 dark:from-dark-bg dark:via-gray-900 dark:to-gray-800 flex items-center justify-center p-4 transition-colors duration-300">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="card card-hover">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-primary mb-4 shadow-glow">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" /></svg>
            </div>
            <h1 className="text-3xl font-bold text-gradient">Регистрация</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Создайте аккаунт и начните работу с датасетами</p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Email</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" /></svg></div>
                <input type="email" className="input-field pl-10" placeholder="you@example.com" {...rhfRegister("email", { required: "Укажите email", pattern: { value: /^\S+@\S+\.\S+$/, message: "Неверный формат email" } })} />
              </div>
              {errors.email && <p className="mt-1 text-sm text-red-600 animate-fade-in">{errors.email.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Username</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg></div>
                <input type="text" className="input-field pl-10" placeholder="username" {...rhfRegister("username", { required: "Укажите username", minLength: { value: 3, message: "Минимум 3 символа" } })} />
              </div>
              {errors.username && <p className="mt-1 text-sm text-red-600 animate-fade-in">{errors.username.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Пароль</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg></div>
                <input type="password" className="input-field pl-10" placeholder="••••••••" {...rhfRegister("password", { required: "Укажите пароль", minLength: { value: 8, message: "Минимум 8 символов" } })} />
              </div>
              {errors.password && <p className="mt-1 text-sm text-red-600 animate-fade-in">{errors.password.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Роль</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg></div>
                <select className="input-field pl-10 appearance-none" {...rhfRegister("role")}>
                  <option value="customer">👤 Заказчик</option>
                  <option value="annotator">✏️ Исполнитель</option>
                  <option value="admin">👑 Админ</option>
                </select>
              </div>
            </div>

            {error && (
              <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 animate-fade-in">
                <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
              </div>
            )}

            <button type="submit" disabled={loading} className="w-full py-3 px-4 rounded-lg bg-gradient-primary text-white font-semibold shadow-lg hover:shadow-glow-lg transform hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2">
              {loading ? <span className="flex items-center justify-center gap-2"><svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Регистрация...</span> : "Создать аккаунт"}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700 text-center">
            <p className="text-sm text-gray-600 dark:text-gray-400">Уже есть аккаунт? <Link to="/login" className="font-semibold text-primary-600 dark:text-primary-400 hover:text-primary-700 transition-colors">Войти</Link></p>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-gray-500">Регистрируясь, вы принимаете <a href="#" className="underline hover:text-primary-600">Условия использования</a> и <a href="#" className="underline hover:text-primary-600">Политику конфиденциальности</a></p>
      </div>
    </div>
  );
}
