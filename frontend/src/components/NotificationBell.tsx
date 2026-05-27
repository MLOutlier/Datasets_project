import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { notificationsAPI } from "../services/api";
import { Notification } from "../types";
import { useAuthStore } from "../store";

function formatRelativeTime(dateString: string): string {
    // Парсим UTC дату из ISO строки
    const utcDate = new Date(dateString);
    
    // Получаем смещение часового пояса в миллисекундах
    const timezoneOffset = utcDate.getTimezoneOffset() * 60000;
    
    // Конвертируем в локальное время (прибавляем смещение)
    const localDate = new Date(utcDate.getTime() - timezoneOffset);
    
    const now = new Date();
    
    // Вычисляем разницу с учётом локального времени
    const diffMs = now.getTime() - localDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return "только что";
    
    if (diffMins < 60) {
        const lastDigit = diffMins % 10;
        const lastTwo = diffMins % 100;
        let word = "минут";
        if (lastTwo >= 11 && lastTwo <= 14) word = "минут";
        else if (lastDigit === 1) word = "минуту";
        else if (lastDigit >= 2 && lastDigit <= 4) word = "минуты";
        else word = "минут";
        return `${diffMins} ${word} назад`;
    }
    
    if (diffHours < 24) {
        const lastDigit = diffHours % 10;
        const lastTwo = diffHours % 100;
        let word = "часов";
        if (lastTwo >= 11 && lastTwo <= 14) word = "часов";
        else if (lastDigit === 1) word = "час";
        else if (lastDigit >= 2 && lastDigit <= 4) word = "часа";
        else word = "часов";
        return `${diffHours} ${word} назад`;
    }
    
    if (diffDays < 7) {
        return localDate.toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    
    return localDate.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

function getIcon(type: string): string {
    const icons: Record<string, string> = {
        task_assigned: "📋",
        task_submitted: "📤",
        task_approved: "✅",
        task_rejected: "❌",
        payment_received: "💰",
        project_created: "🚀",
        project_completed: "🎉",
    };
    return icons[type] || "🔔";
}

function getNotificationUrl(notification: Notification): string {
    const data = notification.data || {};
    const projectId = data.project_id;
    const assignmentId = data.assignment_id;
    const projectType = data.project_type;
    const workflowStage = data.workflow_stage;

    if (projectType === "bbox" && workflowStage === "annotation") {
        if (projectId) return `/labeling/projects/${projectId}`;
    }
    if (projectType === "bbox" && workflowStage === "validation") {
        if (projectId) return `/labeling/bbox-validation?projectId=${projectId}`;
    }
    if (projectType === "interval" && workflowStage === "annotation") {
        if (projectId) return `/labeling/intervals?projectId=${projectId}&stage=intervals`;
    }
    if (projectType === "interval" && workflowStage === "validation") {
        if (projectId) return `/labeling/intervals?projectId=${projectId}&stage=interval-validation`;
    }
    if (projectType === "generic") {
        if (projectId) return `/labeling/generic/${projectId}`;
    }
    if (workflowStage === "review" && assignmentId) {
        if (projectId) return `/projects/${projectId}/workflow`;
    }
    if (projectId) return `/projects/${projectId}`;
    
    return "/";
}

function NotificationItem({ notification, onRead }: { notification: Notification; onRead: () => void }) {
    const navigate = useNavigate();
    const markReadMutation = useMutation({
        mutationFn: () => notificationsAPI.markRead(notification.id),
        onSuccess: onRead,
    });

    const handleClick = () => {
        if (!notification.is_read) {
            markReadMutation.mutate();
        }
        const url = getNotificationUrl(notification);
        navigate(url);
    };

    return (
        <div
            className={`p-3 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition ${
                !notification.is_read ? "bg-blue-50 dark:bg-blue-900/20" : ""
            }`}
            onClick={handleClick}
        >
            <div className="flex items-start gap-3">
                <div className="text-xl">{getIcon(notification.type)}</div>
                <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 dark:text-white text-sm">{notification.title}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{notification.message}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{formatRelativeTime(notification.created_at)}</div>
                </div>
                {!notification.is_read && <div className="w-2 h-2 rounded-full bg-blue-500 mt-2"></div>}
            </div>
        </div>
    );
}

export function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const user = useAuthStore((s) => s.user);
    const queryClient = useQueryClient();
    
    const { data, refetch } = useQuery({
        queryKey: ["notifications"],
        queryFn: () => notificationsAPI.list({ limit: 20 }),
        enabled: !!user,
        refetchInterval: 30000,
    });

    const markAllReadMutation = useMutation({
        mutationFn: () => notificationsAPI.markAllRead(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
            queryClient.invalidateQueries({ queryKey: ["notifications-unread"] });
        },
    });

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const unreadCount = data?.unread_count || 0;
    const notifications = data?.items || [];

    if (!user) return null;

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => {
                    setIsOpen(!isOpen);
                    if (!isOpen) refetch();
                }}
                className="relative p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 inline-flex items-center justify-center w-4 h-4 text-xs font-bold text-white bg-red-500 rounded-full">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}
            </button>
            
            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                        <h3 className="font-semibold text-gray-900 dark:text-white">Уведомления</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={() => markAllReadMutation.mutate()}
                                className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                            >
                                Прочитать все
                            </button>
                        )}
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="p-4 text-center text-gray-500 dark:text-gray-400">Нет уведомлений</div>
                        ) : (
                            notifications.map((n) => (
                                <NotificationItem
                                    key={n.id}
                                    notification={n}
                                    onRead={() => {
                                        queryClient.invalidateQueries({ queryKey: ["notifications"] });
                                        queryClient.invalidateQueries({ queryKey: ["notifications-unread"] });
                                    }}
                                />
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
