type LoadingSpinnerProps = {
  label?: string;
  size?: "sm" | "md" | "lg";
};

const sizeClasses = { sm: "h-3 w-3 border-2", md: "h-4 w-4 border-2", lg: "h-6 w-6 border-4" };

export function LoadingSpinner({ label = "Загрузка...", size = "md" }: LoadingSpinnerProps) {
  return (
    <div className="flex items-center gap-3 py-4 text-sm text-gray-600 dark:text-gray-400">
      <span className={`inline-block animate-spin rounded-full border-gray-300 border-t-gray-900 dark:border-t-white ${sizeClasses[size]}`} />
      <span>{label}</span>
    </div>
  );
}
