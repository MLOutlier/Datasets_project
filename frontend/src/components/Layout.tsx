/**
 * 📐 Основной макет (Layout) для всех защищённых страниц
 *
 * Особенности:
 * - Фиксированный сайдбар слева (ширина 18rem / w-72)
 * - Фиксированный хедер сверху (высота 4rem / h-16)
 * - Основной контент с правильными отступами
 * - Минимальная высота экрана (min-h-screen)
 * - Поддержка тёмной темы через Tailwind
 */

import React from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors duration-300">
      {/* Сайдбар слева — фиксированный */}
      <Sidebar />

      {/* Правая часть: хедер + контент */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Хедер сверху — фиксированный */}
        <Header />

        {/* Основной контент с отступами под сайдбар и хедер */}
        <main className="flex-1 ml-72 mt-16 p-8 overflow-auto">
          <div className="max-w-7xl mx-auto w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
