import React from "react";

type Props = { children: React.ReactNode; fallback?: React.ReactNode };
type State = { hasError: boolean; errorMessage: string | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка UI";
    return { hasError: true, errorMessage: message };
  }

  componentDidCatch(error: unknown) {
    console.error("Ошибка UI:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto max-w-3xl p-6">
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <div className="text-sm font-semibold text-red-900">❌ Произошла ошибка</div>
            <div className="mt-2 text-sm text-red-800">{this.state.errorMessage ?? "Неизвестная ошибка"}</div>
            {this.props.fallback && <div className="mt-4">{this.props.fallback}</div>}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
